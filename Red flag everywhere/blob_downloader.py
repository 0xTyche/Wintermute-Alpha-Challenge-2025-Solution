#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Celestia Blob 数据下载工具

这个脚本用于从Celestia网络批量下载blob数据，支持分批下载和断点续传。
"""

import json
import os
import time
import logging
from datetime import datetime
from typing import Dict, List, Optional, Any
import requests
from urllib3.util.retry import Retry
from requests.adapters import HTTPAdapter
from tqdm import tqdm


class BlobDownloader:
    """
    Celestia Blob 数据下载器
    
    功能：
    - 分批下载blob数据
    - 自动保存进度
    - 错误重试机制
    - 断点续传
    """
    
    def __init__(self, config_file: str = "config.json"):
        """
        初始化下载器
        
        Args:
            config_file: 配置文件路径
        """
        self.config = self._load_config(config_file)
        self.session = self._create_session()
        self.logger = self._setup_logger()
        
        # 创建输出目录
        os.makedirs(self.config["output_dir"], exist_ok=True)
        
        # 初始化进度
        self.progress = self._load_progress()
        
    def _load_config(self, config_file: str) -> Dict[str, Any]:
        """加载配置文件"""
        try:
            with open(config_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        except FileNotFoundError:
            self.logger.error(f"配置文件 {config_file} 不存在")
            raise
        except json.JSONDecodeError as e:
            self.logger.error(f"配置文件格式错误: {e}")
            raise
    
    def _create_session(self) -> requests.Session:
        """创建HTTP会话，包含重试策略"""
        session = requests.Session()
        
        # 设置重试策略
        retry_strategy = Retry(
            total=self.config["max_retries"],
            backoff_factor=1,
            status_forcelist=[429, 500, 502, 503, 504],
        )
        
        adapter = HTTPAdapter(max_retries=retry_strategy)
        session.mount("http://", adapter)
        session.mount("https://", adapter)
        
        # 设置请求头
        session.headers.update({
            'User-Agent': 'Celestia-Blob-Downloader/1.0',
            'Accept': 'application/json'
        })
        
        return session
    
    def _setup_logger(self) -> logging.Logger:
        """设置日志记录器"""
        logger = logging.getLogger('BlobDownloader')
        logger.setLevel(logging.INFO)
        
        # 避免重复添加处理器
        if not logger.handlers:
            # 文件处理器
            file_handler = logging.FileHandler(
                self.config["log_file"], 
                encoding='utf-8'
            )
            file_handler.setLevel(logging.INFO)
            
            # 控制台处理器
            console_handler = logging.StreamHandler()
            console_handler.setLevel(logging.INFO)
            
            # 设置格式
            formatter = logging.Formatter(
                '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
            )
            file_handler.setFormatter(formatter)
            console_handler.setFormatter(formatter)
            
            logger.addHandler(file_handler)
            logger.addHandler(console_handler)
        
        return logger
    
    def _load_progress(self) -> Dict[str, Any]:
        """加载下载进度"""
        progress_file = self.config["progress_file"]
        
        if os.path.exists(progress_file):
            try:
                with open(progress_file, 'r', encoding='utf-8') as f:
                    progress = json.load(f)
                    self.logger.info(f"已加载进度: offset={progress.get('current_offset', 0)}, "
                                   f"总数={progress.get('total_downloaded', 0)}")
                    return progress
            except Exception as e:
                self.logger.warning(f"无法加载进度文件: {e}")
        
        # 返回默认进度
        return {
            "current_offset": 0,
            "total_downloaded": 0,
            "last_update": None,
            "batch_count": 0
        }
    
    def _save_progress(self):
        """保存下载进度"""
        self.progress["last_update"] = datetime.now().isoformat()
        
        try:
            with open(self.config["progress_file"], 'w', encoding='utf-8') as f:
                json.dump(self.progress, f, indent=2, ensure_ascii=False)
        except Exception as e:
            self.logger.error(f"保存进度失败: {e}")
    
    def _make_api_request(self, offset: int, limit: int) -> Optional[List[Dict]]:
        """
        发起API请求
        
        Args:
            offset: 偏移量
            limit: 限制数量
            
        Returns:
            API响应数据，失败时返回None
        """
        url = self.config["api_base_url"]
        params = {
            "sort_by": "time",
            "limit": limit,
            "offset": offset
        }
        
        for attempt in range(self.config["max_retries"] + 1):
            try:
                self.logger.info(f"请求API: offset={offset}, limit={limit}, 尝试={attempt+1}")
                
                response = self.session.get(
                    url, 
                    params=params, 
                    timeout=self.config["request_timeout"]
                )
                response.raise_for_status()
                
                data = response.json()
                self.logger.info(f"成功获取 {len(data)} 条数据")
                return data
                
            except requests.exceptions.RequestException as e:
                self.logger.warning(f"请求失败 (尝试 {attempt+1}): {e}")
                
                if attempt < self.config["max_retries"]:
                    time.sleep(self.config["retry_delay"] * (attempt + 1))
                else:
                    self.logger.error(f"达到最大重试次数，跳过offset={offset}")
                    return None
    
    def _save_batch_data(self, data: List[Dict], batch_index: int):
        """
        保存批次数据到JSON文件
        
        Args:
            data: 要保存的数据
            batch_index: 批次索引
        """
        filename = f"blob_batch_{batch_index}.json"
        filepath = os.path.join(self.config["output_dir"], filename)
        
        try:
            with open(filepath, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            
            self.logger.info(f"已保存批次数据: {filename} ({len(data)} 条记录)")
            
        except Exception as e:
            self.logger.error(f"保存批次数据失败: {e}")
            raise
    
    def download_all_blobs(self):
        """
        下载所有blob数据
        
        这是主要的下载方法，会持续请求API直到没有更多数据
        """
        self.logger.info("开始下载blob数据...")
        self.logger.info(f"配置: 批次大小={self.config['batch_size']}, "
                        f"输出目录={self.config['output_dir']}")
        
        current_offset = self.progress["current_offset"]
        batch_count = self.progress["batch_count"]
        
        # 创建进度条
        pbar = tqdm(
            desc="下载进度", 
            unit="条", 
            initial=self.progress["total_downloaded"]
        )
        
        try:
            while True:
                # 请求当前批次数据
                data = self._make_api_request(
                    current_offset, 
                    self.config["batch_size"]
                )
                
                if not data:
                    self.logger.warning("获取数据失败，跳过当前批次")
                    current_offset += self.config["batch_size"]
                    continue
                
                # 如果没有更多数据，结束下载
                if len(data) == 0:
                    self.logger.info("没有更多数据，下载完成")
                    break
                
                # 保存批次数据
                self._save_batch_data(data, batch_count)
                
                # 更新进度
                current_offset += len(data)
                self.progress["current_offset"] = current_offset
                self.progress["total_downloaded"] += len(data)
                self.progress["batch_count"] = batch_count + 1
                
                # 更新进度条
                pbar.update(len(data))
                pbar.set_postfix({
                    "批次": batch_count + 1,
                    "偏移": current_offset
                })
                
                # 保存进度
                self._save_progress()
                
                batch_count += 1
                
                # 如果获取的数据少于批次大小，说明已经到末尾
                if len(data) < self.config["batch_size"]:
                    self.logger.info("已获取所有可用数据")
                    break
                
                # 短暂休息，避免过于频繁的请求
                time.sleep(0.1)
                
        except KeyboardInterrupt:
            self.logger.info("用户中断下载")
        except Exception as e:
            self.logger.error(f"下载过程中发生错误: {e}")
            raise
        finally:
            pbar.close()
            self._save_progress()
        
        self.logger.info(f"下载完成! 总共下载 {self.progress['total_downloaded']} 条记录，"
                        f"保存了 {self.progress['batch_count']} 个批次文件")
    
    def get_download_stats(self) -> Dict[str, Any]:
        """
        获取下载统计信息
        
        Returns:
            包含统计信息的字典
        """
        return {
            "total_downloaded": self.progress["total_downloaded"],
            "batch_count": self.progress["batch_count"],
            "current_offset": self.progress["current_offset"],
            "last_update": self.progress["last_update"]
        }


def main():
    """主函数"""
    try:
        # 创建下载器实例
        downloader = BlobDownloader()
        
        # 显示当前进度
        stats = downloader.get_download_stats()
        print("\n" + "="*50)
        print("Celestia Blob 数据下载工具")
        print("="*50)
        print(f"已下载数据: {stats['total_downloaded']} 条")
        print(f"已保存批次: {stats['batch_count']} 个")
        print(f"当前偏移: {stats['current_offset']}")
        if stats['last_update']:
            print(f"上次更新: {stats['last_update']}")
        print("="*50 + "\n")
        
        # 开始下载
        downloader.download_all_blobs()
        
        # 显示最终统计
        final_stats = downloader.get_download_stats()
        print("\n" + "="*50)
        print("下载完成!")
        print("="*50)
        print(f"总下载数据: {final_stats['total_downloaded']} 条")
        print(f"保存批次文件: {final_stats['batch_count']} 个")
        print(f"数据保存在: {downloader.config['output_dir']} 目录")
        print("="*50)
        
    except Exception as e:
        print(f"程序运行出错: {e}")
        return 1
    
    return 0


if __name__ == "__main__":
    exit(main()) 