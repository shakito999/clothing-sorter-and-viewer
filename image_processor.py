"""
Image processing utilities for Vendora Auto-Lister
Handles compression, format conversion, and image analysis
"""

import os
import base64
import logging
import re
from PIL import Image
import io
from typing import Tuple, List, Optional
import shutil
import json
from datetime import datetime

from config import INPUT_FOLDER, OUTPUT_FOLDER, PROCESSED_FOLDER, FAILED_FOLDER, THUMBNAIL_SIZE, JPEG_QUALITY

logger = logging.getLogger(__name__)


class ImageProcessor:
    """Handles all image processing operations"""
    
    def __init__(self):
        self.supported_formats = ('.png', '.jpg', '.jpeg', '.webp', '.bmp')
        
    def compress_image(self, image_path: str, max_size: int = THUMBNAIL_SIZE, quality: int = JPEG_QUALITY) -> str:
        """
        Downscales image for AI processing while preserving text readability.
        Returns base64 encoded JPEG string.
        """
        try:
            with Image.open(image_path) as img:
                # Convert to RGB if necessary (for PNG with transparency)
                if img.mode in ('RGBA', 'P'):
                    img = img.convert('RGB')
                
                # Calculate new size maintaining aspect ratio
                width, height = img.size
                if width > height:
                    new_width = min(max_size, width)
                    new_height = int(height * (new_width / width))
                else:
                    new_height = min(max_size, height)
                    new_width = int(width * (new_height / height))
                
                # Only resize if larger than max_size
                if width > max_size or height > max_size:
                    img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
                
                # Save to buffer
                buffer = io.BytesIO()
                img.save(buffer, format="JPEG", quality=quality, optimize=True)
                buffer.seek(0)
                
                return base64.b64encode(buffer.getvalue()).decode('utf-8')
                
        except Exception as e:
            logger.error(f"Failed to compress image {image_path}: {e}")
            raise
    
    def get_image_dimensions(self, image_path: str) -> Tuple[int, int]:
        """Returns (width, height) of an image"""
        with Image.open(image_path) as img:
            return img.size
    
    def validate_image(self, image_path: str) -> bool:
        """Check if file is a valid, readable image"""
        try:
            with Image.open(image_path) as img:
                img.verify()
            return True
        except Exception:
            return False


class FileManager:
    """Manages file operations and folder organization"""
    
    def __init__(self):
        self._ensure_folders()
    
    def _ensure_folders(self):
        """Create necessary directories if they don't exist"""
        for folder in [INPUT_FOLDER, OUTPUT_FOLDER, PROCESSED_FOLDER, FAILED_FOLDER]:
            os.makedirs(folder, exist_ok=True)
    
    def get_images_sorted_by_date(self, folder: str = INPUT_FOLDER) -> List[str]:
        """
        Get all images from folder, sorted by timestamp from filename (oldest first).
        Filenames are expected to be in format: YYYYMMDD_HHMMSS.jpg
        Parses timestamps to ensure correct chronological ordering.
        
        IMPORTANT: Files are sorted by the timestamp extracted from the filename,
        NOT by modification time or alphabetical order. This ensures photos taken
        at 17:28:16 appear before photos taken at 17:28:34, even if they were
        downloaded or modified in a different order.
        """
        files_with_time = []
        
        # First, list directory and parse ALL files
        all_files = os.listdir(folder)
        logger.info(f"Raw directory listing: {len(all_files)} items")
        
        for f in all_files:
            if f.lower().endswith(self._supported_formats()):
                full_path = os.path.join(folder, f)
                # Extract timestamp from filename
                timestamp = self._parse_timestamp_from_filename(f)
                files_with_time.append((full_path, timestamp, f))
        
        # Sort by timestamp (oldest first). Files without timestamps go to end.
        # Using stable sort to preserve original order for files without timestamps
        files_with_time.sort(key=lambda x: x[1] if x[1] else datetime.max)
        
        # Extract just the file paths, maintaining sorted order
        sorted_files = [item[0] for item in files_with_time]
        
        # Log the sorted order for debugging
        if sorted_files:
            logger.info(f"Image order (first 5): {[os.path.basename(f) for f in sorted_files[:5]]}")
            if len(sorted_files) > 5:
                logger.info(f"Image order (last 5): {[os.path.basename(f) for f in sorted_files[-5:]]}")
        logger.info(f"Found {len(sorted_files)} images in {folder}, sorted chronologically by filename timestamp")
        
        return sorted_files
    
    def _parse_timestamp_from_filename(self, filename: str) -> Optional[datetime]:
        """Parse timestamp from filename like 20260309_172816.jpg"""
        try:
            # Extract YYYYMMDD_HHMMSS pattern
            match = re.search(r'(\d{8})_(\d{6})', filename)
            if match:
                date_str = match.group(1)  # YYYYMMDD
                time_str = match.group(2)  # HHMMSS
                dt_str = f"{date_str}_{time_str}"
                return datetime.strptime(dt_str, "%Y%m%d_%H%M%S")
        except Exception as e:
            logger.debug(f"Could not parse timestamp from {filename}: {e}")
        return None
    
    def _supported_formats(self) -> Tuple:
        return ('.png', '.jpg', '.jpeg', '.webp', '.bmp')
    
    def create_item_folder(self, item_name: str, base_folder: str = OUTPUT_FOLDER) -> str:
        """Create a uniquely named folder for an item"""
        # Sanitize folder name
        safe_name = self._sanitize_folder_name(item_name)
        
        # Add timestamp to ensure uniqueness
        timestamp = datetime.now().strftime("%H%M%S")
        folder_name = f"{safe_name}_{timestamp}"
        
        item_folder = os.path.join(base_folder, folder_name)
        os.makedirs(item_folder, exist_ok=True)
        
        return item_folder
    
    def _sanitize_folder_name(self, name: str) -> str:
        """Remove characters that are problematic for file paths"""
        name = name.replace(" ", "_")
        name = name.replace("/", "-")
        name = name.replace("\\", "-")
        name = name.replace(":", "-")
        name = name.replace("*", "")
        name = name.replace("?", "")
        name = name.replace('"', "")
        name = name.replace("<", "")
        name = name.replace(">", "")
        name = name.replace("|", "")
        
        if len(name) > 50:
            name = name[:50]
        
        return name
    
    def move_file(self, source: str, destination: str) -> bool:
        """Move file to destination, creating directories if needed"""
        try:
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            shutil.move(source, destination)
            return True
        except Exception as e:
            logger.error(f"Failed to move {source} to {destination}: {e}")
            return False
    
    def copy_file(self, source: str, destination: str) -> bool:
        """Copy file to destination"""
        try:
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            shutil.copy2(source, destination)
            return True
        except Exception as e:
            logger.error(f"Failed to copy {source} to {destination}: {e}")
            return False


class ItemMetadata:
    """Handles metadata storage and retrieval"""
    
    @staticmethod
    def save_as_json(data: dict, folder_path: str, filename: str = "vendora_data.json"):
        """Save item data as JSON"""
        filepath = os.path.join(folder_path, filename)
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        logger.info(f"Saved metadata to {filepath}")
    
    @staticmethod
    def save_as_text(data: dict, folder_path: str, filename: str = "vendora_details.txt"):
        """Save item data as readable text file"""
        filepath = os.path.join(folder_path, filename)
        with open(filepath, 'w', encoding='utf-8') as f:
            for key, value in data.items():
                if isinstance(value, dict):
                    value = json.dumps(value, ensure_ascii=False)
                f.write(f"{key.capitalize()}: {value}\n")
        logger.info(f"Saved text metadata to {filepath}")
    
    @staticmethod
    def save_listing_description(description: str, folder_path: str, filename: str = "listing_description.txt"):
        """Save enhanced listing description as a separate file"""
        filepath = os.path.join(folder_path, filename)
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(description)
        logger.info(f"Saved listing description to {filepath}")
    
    @staticmethod
    def load_from_json(folder_path: str, filename: str = "vendora_data.json") -> dict:
        """Load item data from JSON file"""
        filepath = os.path.join(folder_path, filename)
        if os.path.exists(filepath):
            with open(filepath, 'r', encoding='utf-8') as f:
                return json.load(f)
        return {}
    
    @staticmethod
    def create_readme(folder_path: str, item_data: dict):
        """Create a README with instructions for manual listing"""
        readme_path = os.path.join(folder_path, "README.txt")
        with open(readme_path, 'w', encoding='utf-8') as f:
            f.write("VENDORA AUTO-LISTER - ITEM FOLDER\n")
            f.write("=" * 40 + "\n\n")
            f.write("Images in this folder:\n")
            for img in item_data.get('images', []):
                f.write(f"  - {os.path.basename(img)}\n")
            f.write("\n" + "=" * 40 + "\n")
            f.write("VENDORA LISTING DATA:\n")
            f.write("=" * 40 + "\n\n")
            for key, value in item_data.items():
                if key != 'images' and key != 'batch_index':
                    f.write(f"{key.upper()}: {value}\n")
            f.write("\n" + "=" * 40 + "\n")
            f.write("INSTRUCTIONS:\n")
            f.write("1. Log into your Vendora seller account\n")
            f.write("2. Create a new listing\n")
            f.write("3. Upload all images from this folder\n")
            f.write("4. Fill in the details above\n")
            f.write("5. Publish the listing\n")


# Convenience instances
image_processor = ImageProcessor()
file_manager = FileManager()
