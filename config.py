"""
Configuration for Vendora Auto-Lister
Adjust these settings based on your LM Studio server and preferences
"""

# === LM Studio Server Settings ===
LM_STUDIO_BASE_URL = "http://localhost:1234/v1"  # LM Studio default
MODEL_NAME = "qwen3.5-9b"  # Updated via UI

# === API Settings ===
API_TIMEOUT = 120  # seconds - timeout for each API call
MAX_RETRIES = 2  # Reduce retries to fail faster
RETRY_DELAY = 3  # seconds between retries

# === Image Processing ===
# High quality for reading labels, sizes, measurements
THUMBNAIL_SIZE = 2000  # pixels - larger to preserve text readability
JPEG_QUALITY = 95

# === Path Configuration ===
import os
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_BASE_DIR = os.path.join(BASE_DIR, "backend") if os.path.isdir(os.path.join(BASE_DIR, "backend")) else BASE_DIR

INPUT_FOLDER = os.path.join(DATA_BASE_DIR, "raw_photos")
OUTPUT_FOLDER = os.path.join(DATA_BASE_DIR, "vendora_ready")
PROCESSED_FOLDER = os.path.join(DATA_BASE_DIR, "processed")
FAILED_FOLDER = os.path.join(DATA_BASE_DIR, "failed")



# === Vendora Listing Template ===
VENDORA_CATEGORY = "Clothing"  # Default category
DEFAULT_CONDITION = "Good"  # Fallback if AI can't determine

# === Logging ===
LOG_FILE = "vendora_pipeline.log"
LOG_LEVEL = "INFO"
