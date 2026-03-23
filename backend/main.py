import os
import sys
import json
import asyncio
import logging
import signal
import subprocess
import shutil
import uuid
from datetime import datetime
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from typing import List, Dict, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from ai_client import LMStudioClient, GarmentGrouper, VendoraExtractor, ImageClassifier
from image_processor import image_processor, file_manager, ItemMetadata
from config import INPUT_FOLDER, OUTPUT_FOLDER, BASE_DIR

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Vendora Auto-Lister API",
    description="Real-time image processing pipeline with Qwen3.5 VL multimodal support",
    version="2.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "*"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self.heartbeat_interval = 30

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"Client connected. Total: {len(self.active_connections)}")
        await websocket.send_json({
            "type": "welcome",
            "data": {
                "server_version": "2.0.0",
                "timestamp": datetime.now().isoformat()
            }
        })

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        logger.info(f"Client disconnected. Total: {len(self.active_connections)}")

    async def broadcast(self, message: dict):
        """Send message to all connected clients"""
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                # Silently ignore routine disconnects to avoid spamming logs
                pass

    async def send_personal(self, websocket: WebSocket, message: dict):
        """Send message to specific client"""
        try:
            await websocket.send_json(message)
        except Exception as e:
            logger.error(f"Error sending personal message: {e}")

    async def broadcast_state(self):
        """Broadcast current state to all clients"""
        await self.broadcast({
            "type": "state",
            "data": state.to_dict()
        })


class ItemUpdate(BaseModel):
    item_folder: str
    title: str
    brand: str
    size: str
    condition: str
    material: str
    color: str = ""
    measurements: Dict[str, str] = {}
    visible_flaws: str
    description: str


class RestorePhotoRequest(BaseModel):
    trash_path: str
    original_path: str
    parent_dir: str
    filename: str
    index: Optional[int] = None
    removed_type: Optional[str] = None
    removed_caption: Optional[str] = None


manager = ConnectionManager()


# Pipeline state with metadata/time tracking
class PipelineState:
    def __init__(self):
        self.is_running = False
        self.is_paused = False
        self.should_stop = False
        self.current_phase = "idle"
        self.current_batch = 0
        self.total_batches = 0
        self.current_operation = ""
        self.batches: List[List[str]] = []
        self.extracted_data: List[Dict] = []
        self.logs: List[Dict] = []
        self.stats = {
            "total_images": 0,
            "total_garments": 0,
            "successful": 0,
            "failed": 0
        }
        self.started_at: Optional[datetime] = None
        self.ended_at: Optional[datetime] = None

    def reset(self):
        self.is_running = False
        self.is_paused = False
        self.should_stop = False
        self.current_phase = "idle"
        self.current_batch = 0
        self.total_batches = 0
        self.current_operation = ""
        self.batches = []
        self.extracted_data = []
        self.logs = []
        self.started_at = None
        self.ended_at = None
        self.stats = {
            "total_images": 0,
            "total_garments": 0,
            "successful": 0,
            "failed": 0
        }

    def to_dict(self) -> dict:
        return {
            "is_running": self.is_running,
            "is_paused": self.is_paused,
            "phase": self.current_phase,
            "current_batch": self.current_batch,
            "total_batches": self.total_batches,
            "current_operation": self.current_operation,
            "stats": self.stats,
            "extracted_data": self.extracted_data,
            "logs": self.logs,  # Unlimited history
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "ended_at": self.ended_at.isoformat() if self.ended_at else None,
            "elapsed_seconds": (datetime.now() - self.started_at).total_seconds() if self.started_at else 0
        }


state = PipelineState()
executor = ThreadPoolExecutor(max_workers=1)


def add_log(message: str, level: str = "info"):
    """Add log entry and broadcast to clients"""
    timestamp = datetime.now().strftime("%H:%M:%S")
    log_entry = {
        "time": timestamp,
        "level": level,
        "message": message
    }
    state.logs.append(log_entry)
    # No truncation - developer requested all entries

    # Broadcast immediately to all clients
    try:
        asyncio.create_task(manager.broadcast({
            "type": "log",
            "data": log_entry
        }))
    except RuntimeError:
        # Not in async context - will be handled by caller
        pass


async def run_pipeline():
    """Run the image processing pipeline"""
    state.reset()
    state.is_running = True
    state.started_at = datetime.now()

    try:
        # Get images
        images = file_manager.get_images_sorted_by_date()
        if not images:
            add_log("No images found in input folder", "error")
            return

        state.stats["total_images"] = len(images)
        add_log(f"Starting pipeline with {len(images)} images", "info")

        # Broadcast initial state
        await manager.broadcast({"type": "state", "data": state.to_dict()})

        # Phase 1: Group images
        state.current_phase = "grouping"
        batches, classifications_cache = await group_images(images)
        state.batches = batches
        state.stats["total_garments"] = len(batches)

        if state.should_stop:
            add_log("Pipeline stopped by user", "warning")
            return

        # Phase 2: Extract and file (pass cached classifications - no re-runs!)
        state.current_phase = "extraction"
        await extract_and_file(batches, classifications_cache)

        state.current_phase = "complete"
        add_log("Pipeline completed successfully!", "success")

    except Exception as e:
        logger.error(f"Pipeline error: {e}")
        add_log(f"Pipeline error: {e}", "error")
        state.current_phase = "error"
    finally:
        state.ended_at = datetime.now()
        state.is_running = False
        await manager.broadcast({"type": "state", "data": state.to_dict()})


async def group_images(images: List[str]) -> tuple:
    """Phase 1: Group images by garment using AI with pre-classification.
    Returns: (batches, classifications_cache) where cache maps image_path -> (type, caption)"""
    add_log("Phase 1: Grouping images by garment", "info")

    classifications_cache = {}

    if not images:
        return [], classifications_cache

    client = LMStudioClient()
    grouper = GarmentGrouper(client)
    classifier = ImageClassifier(client)
    extractor = VendoraExtractor(client)

    batches = []
    current_batch = [images[0]]

    # Classify first image (using low-res for speed)
    ref_b64 = image_processor.compress_image(images[0], max_size=800, quality=80)
    ref_name = os.path.basename(images[0])
    ref_type, ref_caption = await asyncio.to_thread(classifier.classify, ref_b64)
    classifications_cache[images[0]] = (ref_type, ref_caption)
    add_log(f"Reference image: {ref_name} -> {ref_type} | {ref_caption}", "info")

    # Get compressed image for display
    ref_display = image_processor.compress_image(images[0], max_size=400)

    # Send classification update with image
    await manager.broadcast({
        "type": "image_classification",
        "data": {
            "image": ref_name,
            "image_data": ref_display,
            "type": ref_type,
            "batch": 0,
            "reason": "Reference image"
        }
    })

    state.total_batches = len(images) - 1

    known_brand = None  # Track brand of current garment being grouped

    for i, img_path in enumerate(images[1:], start=1):
        if state.should_stop:
            break

        state.current_batch = i
        state.current_operation = f"Classifying and comparing image {i}/{len(images)-1}"

        test_name = os.path.basename(img_path)

        try:
            # Get file metadata for context
            file_stat = os.stat(img_path)
            prev_stat = os.stat(current_batch[-1])

            # Calculate time difference in seconds between current and immediately previous photo
            time_diff = file_stat.st_mtime - prev_stat.st_mtime

            # CRITICAL PIECE: Always compare against the FIRST photo of the garment (the anchor)
            reference_img = current_batch[0]

            # Get image data downscaled but legible for grouping and initial captioning
            ref_b64 = image_processor.compress_image(reference_img, max_size=1200, quality=85)
            test_b64 = image_processor.compress_image(img_path, max_size=1200, quality=85)

            # Get filenames for context
            ref_name = os.path.basename(reference_img)

            # Classify test image first (cache type + caption)
            test_type, test_caption = await asyncio.to_thread(classifier.classify, test_b64)
            classifications_cache[img_path] = (test_type, test_caption)
            add_log(f"Classified: {test_name} -> {test_type} | {test_caption}", "info")

            # Send classification update immediately with image
            test_display = image_processor.compress_image(img_path, max_size=400)
            await manager.broadcast({
                "type": "image_classification",
                "data": {
                    "image": test_name,
                    "image_data": test_display,
                    "type": test_type,
                    "batch": i,
                    "reason": f"Time diff: {int(time_diff)}s"
                }
            })

            # CRITICAL FIX: If test image is DETAIL_SHOT, it's always part of current batch
            if test_type == "DETAIL_SHOT":
                add_log("  -> DETAIL_SHOT detected, grouping with current garment", "info")
                current_batch.append(img_path)
            else:
                # Only run AI comparison for FULL_FRONT images
                is_same, reasoning, confidence = await asyncio.to_thread(
                    grouper.are_same_garment_with_context,
                    ref_b64, test_b64,
                    ref_name, test_name,
                    time_diff,
                    None, None,
                    known_brand,
                    os.path.basename(current_batch[-1])
                )

                add_log(f"AI: {reasoning[:300]} (conf: {confidence:.1f}%)", "info")

                # Send comparison result update with actual images
                ref_display = image_processor.compress_image(reference_img, max_size=400)
                test_display = image_processor.compress_image(img_path, max_size=400)
                await manager.broadcast({
                    "type": "comparison_result",
                    "data": {
                        "reference": ref_name,
                        "reference_image": ref_display,
                        "current": test_name,
                        "current_image": test_display,
                        "is_same": is_same,
                        "reasoning": reasoning,
                        "confidence": confidence,
                        "time_diff_seconds": time_diff,
                        "batch_index": len(batches),
                        "images_in_current_batch": len(current_batch)
                    }
                })

                if is_same:
                    current_batch.append(img_path)
                    add_log(f"SAME garment (batch: {len(current_batch)} images)", "success")
                else:
                    batches.append(current_batch)
                    add_log(f"NEW garment (batch closed: {len(current_batch)} images)", "warning")
                    current_batch = [img_path]

                    # Update reference for new batch
                    ref_type, _ = await asyncio.to_thread(classifier.classify, test_b64)
                    add_log(f"New reference: {test_name} -> {ref_type}", "info")

                    # Extract brand from new FULL_FRONT image for future comparisons
                    if ref_type == "FULL_FRONT_FLATLAY":
                        extraction = await asyncio.to_thread(extractor.extract_single, test_b64)
                        known_brand = extraction.get("brand") if extraction else None
                        if known_brand:
                            add_log(f"  -> Brand identified: {known_brand}", "info")
                    else:
                        known_brand = None

        except Exception as e:
            add_log(f"Error processing {test_name}: {e} - assuming SAME", "error")
            current_batch.append(img_path)

        # Broadcast progress
        await manager.broadcast({"type": "state", "data": state.to_dict()})

    # Final batch
    if current_batch and not state.should_stop:
        batches.append(current_batch)
        add_log(f"Final batch: {len(current_batch)} images", "info")

    add_log(f"Grouping complete: {len(batches)} garments found", "success")
    return batches, classifications_cache


async def extract_and_file(batches: List[List[str]], classifications_cache: dict = None):
    """Phase 2: Extract data and create folders using Master AI Prompt.
    Uses cached classifications from Phase 1 - zero redundant AI calls!"""
    add_log("Phase 2: Extracting data with Master AI Prompt", "info")

    if classifications_cache is None:
        classifications_cache = {}

    client = LMStudioClient()
    extractor = VendoraExtractor(client)

    for batch_idx, batch in enumerate(batches, start=1):
        if state.should_stop:
            break

        state.current_batch = batch_idx
        state.total_batches = len(batches)
        state.current_operation = f"Processing garment {batch_idx}/{len(batches)}"

        try:
            add_log(f"Processing garment {batch_idx} ({len(batch)} images)", "info")

            # Use cached classifications from Phase 1 (ZERO extra AI calls)
            image_types = []
            image_captions = []
            for img_path in batch:
                cached = classifications_cache.get(img_path)
                if cached:
                    img_type, caption = cached
                else:
                    img_type, caption = "UNKNOWN", "No cached classification"
                image_types.append(img_type)
                image_captions.append(caption)
                add_log(f"  {os.path.basename(img_path)}: {img_type} | {caption}", "info")

            # Count image types
            full_front_count = image_types.count("FULL_FRONT_FLATLAY")
            detail_count = image_types.count("DETAIL_SHOT")
            add_log(f"  Summary: {full_front_count} flatlay, {detail_count} detail shots", "info")

            # Smart Hybrid Compression Strategy for final extraction
            b64_batch = []
            has_full_front = False
            details_added = 0

            for img_path, img_type in zip(batch, image_types):
                if img_type == "FULL_FRONT_FLATLAY":
                    # First full front image gets heavily downscaled (AI only needs basic shape/color here to save VRAM)
                    if not has_full_front:
                        b64_batch.append(image_processor.compress_image(img_path, max_size=800, quality=85))
                        has_full_front = True
                else:
                    # Detail shots at 1024px - balanced for OCR without killing VRAM
                    if details_added < 4:
                        b64_batch.append(image_processor.compress_image(img_path, max_size=1024, quality=90))
                        details_added += 1

            # If batch is still empty somehow, fallback to first image heavily compressed
            if not b64_batch:
                b64_batch.append(image_processor.compress_image(batch[0], max_size=800, quality=85))

            # Try to extract data using Master AI Prompt
            try:
                item_data = await asyncio.to_thread(extractor.extract_data, b64_batch, image_captions)
            except Exception as extract_error:
                add_log(f"  AI Extraction Failed: {str(extract_error)[:100]}. Saving images anyway.", "error")
                item_data = {
                    "title": f"Needs Manual Review - Item {batch_idx}",
                    "brand": "Unknown",
                    "size": "Unknown",
                    "condition": "Unknown",
                    "color": "Unknown",
                    "material": "Unknown",
                    "measurements": {},
                    "description": "AI metadata extraction failed due to unpredictable format. Please categorize manually."
                }

            # Log extraction results
            add_log(f"  Item: {item_data.get('title', 'Unknown')}", "info")
            add_log(f"  Brand: {item_data.get('brand', 'Unknown')}, Size: {item_data.get('size', 'Unknown')}", "info")
            add_log(f"  Color: {item_data.get('color', 'Unknown')}, Material: {item_data.get('material', 'Unknown')}", "info")

            if item_data.get("measurements"):
                add_log(f"  Measurements: {item_data.get('measurements')}", "info")

            # FIX: Ensure condition and description fields are properly set
            if item_data.get("visible_flaws") and item_data.get("visible_flaws") != "None":
                add_log(f"  Flaws: {item_data['visible_flaws']}", "warning")

            # Create folder
            item_title = item_data.get("title", f"Item_{batch_idx}")
            safe_title = sanitize_folder_name(item_title)
            item_folder = os.path.join(OUTPUT_FOLDER, f"{safe_title}_{batch_idx:03d}")
            os.makedirs(item_folder, exist_ok=True)

            # Copy images and aggregate captions into one file
            all_captions = []
            for img_path, caption in zip(batch, image_captions):
                img_name = os.path.basename(img_path)
                dest = os.path.join(item_folder, img_name)
                file_manager.copy_file(img_path, dest)
                all_captions.append(f"{img_name}: {caption}")

            with open(os.path.join(item_folder, "captions.txt"), "w", encoding="utf-8") as f:
                f.write("\n".join(all_captions))

            # Add metadata with image types and captions
            item_data["images"] = [os.path.basename(img) for img in batch]
            item_data["image_types"] = image_types
            item_data["image_captions"] = image_captions
            item_data["batch_index"] = batch_idx
            item_data["processed_at"] = datetime.now().isoformat()
            item_data["output_folder"] = item_folder

            # Ensure required fields exist
            if "measurements" not in item_data or item_data["measurements"] is None:
                item_data["measurements"] = {}
            if "condition" not in item_data or not item_data["condition"]:
                item_data["condition"] = "Good"

            # Generate AI-written description using Qwen (TEXT-ONLY call, very fast)
            try:
                add_log("  Generating listing description...", "info")
                desc = await asyncio.to_thread(extractor.generate_ai_description, item_data, image_captions)
                item_data["enhanced_description"] = desc
                item_data["description"] = desc
            except Exception as desc_err:
                add_log(f"  Description generation failed: {str(desc_err)[:80]}", "warning")
                item_data["description"] = f"{item_data.get('brand', '')} {item_data.get('item_type', '')} in {item_data.get('color', '')} color"

            metadata_folder = os.path.join(item_folder, "metadata")
            os.makedirs(metadata_folder, exist_ok=True)

            ItemMetadata.save_as_json(item_data, metadata_folder)
            ItemMetadata.save_as_text(item_data, metadata_folder)
            ItemMetadata.create_readme(metadata_folder, item_data)

            if item_data.get("enhanced_description"):
                ItemMetadata.save_listing_description(item_data["enhanced_description"], item_folder)

            state.extracted_data.append(item_data)
            state.stats["successful"] += 1
            add_log(f"Created: {os.path.basename(item_folder)}", "success")
            add_log(f"Title: {item_title}", "info")

            await manager.broadcast({"type": "item_complete", "data": item_data})

        except Exception as e:
            state.stats["failed"] += 1
            add_log(f"Failed: {e}", "error")

        await manager.broadcast({"type": "state", "data": state.to_dict()})


def load_state_from_disk():
    """Load previously processed items from OUTPUT_FOLDER on startup."""
    if not os.path.exists(OUTPUT_FOLDER):
        return

    count = 0
    for folder_name in os.listdir(OUTPUT_FOLDER):
        item_folder = os.path.join(OUTPUT_FOLDER, folder_name)
        if not os.path.isdir(item_folder):
            continue

        metadata_path = os.path.join(item_folder, "metadata")
        if not os.path.exists(metadata_path):
            continue

        try:
            item_data = ItemMetadata.load_from_json(metadata_path)
            if item_data:
                item_data["output_folder"] = item_folder
                state.extracted_data.append(item_data)
                count += 1
        except Exception as e:
            logger.error(f"Error loading metadata from {item_folder}: {e}")

    state.extracted_data.sort(key=lambda x: x.get("processed_at", ""), reverse=False)
    state.stats["successful"] = count
    state.stats["total_garments"] = count
    add_log(f"Restored {count} items from disk", "success")


def sanitize_folder_name(name: str) -> str:
    """Create safe folder name"""
    import re
    name = re.sub(r'[<>:"/\\|?*]', "", name)
    name = name.replace(" ", "_")
    return name[:50]


def open_folder_with_explorer(path: str):
    abs_path = os.path.abspath(path)
    if not os.path.exists(abs_path):
        os.makedirs(abs_path, exist_ok=True)
    if os.name == "nt":
        subprocess.Popen(["explorer", abs_path])
    elif sys.platform == "darwin":
        subprocess.Popen(["open", abs_path])
    else:
        subprocess.Popen(["xdg-open", abs_path])
    return abs_path


# ============== API Routes ==============

@app.get("/")
async def root():
    return {"message": "Vendora Auto-Lister API", "status": "running"}


@app.get("/api/state")
async def get_state():
    """Get current pipeline state"""
    return state.to_dict()


@app.get("/api/images")
async def get_images():
    """Get list of images in input folder"""
    try:
        images = file_manager.get_images_sorted_by_date()
        return {
            "count": len(images),
            "images": [os.path.basename(f) for f in images]
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/output")
async def get_output():
    """Get list of completed listings"""
    try:
        folders = []
        if os.path.exists(OUTPUT_FOLDER):
            for folder in os.listdir(OUTPUT_FOLDER):
                folder_path = os.path.join(OUTPUT_FOLDER, folder)
                if os.path.isdir(folder_path):
                    data_file = os.path.join(folder_path, "metadata", "vendora_data.json")
                    if os.path.exists(data_file):
                        with open(data_file, "r", encoding="utf-8") as f:
                            data = json.load(f)
                    else:
                        data = {"title": folder}
                    folders.append({
                        "name": folder,
                        "path": folder_path,
                        "data": data
                    })
        return {"count": len(folders), "folders": folders}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/start")
async def start_pipeline():
    """Start the pipeline"""
    if state.is_running:
        raise HTTPException(status_code=400, detail="Pipeline already running")
    asyncio.create_task(run_pipeline())
    return {"message": "Pipeline started"}


@app.post("/api/stop")
async def stop_pipeline():
    """Stop the pipeline"""
    state.should_stop = True
    state.is_running = False
    state.current_phase = "stopped"
    add_log("Stop requested by user", "warning")
    await manager.broadcast({"type": "state", "data": state.to_dict()})
    return {"message": "Stop requested"}


@app.post("/api/clear")
async def clear_output():
    """Clear output folder"""
    # shutil.rmtree(OUTPUT_FOLDER)
    # os.makedirs(OUTPUT_FOLDER, exist_ok=True)
    add_log("Mass-deletion of 'vendora_ready' is currently DISABLED for your safety.", "warning")
    state.reset()
    return {"message": "Mass-deletion is disabled for safety"}


@app.post("/api/open-folder")
async def open_folder(request: dict):
    """Open a folder in file explorer"""
    try:
        path = request.get("path", "")
        path = path.replace("\\", "/")
        abs_path = open_folder_with_explorer(path)
        return {"message": f"Opened: {abs_path}", "path": abs_path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/open-input-folder")
async def open_input_folder():
    """Open the input photos folder"""
    try:
        abs_path = open_folder_with_explorer(INPUT_FOLDER)
        count = len(file_manager.get_images_sorted_by_date())
        return {"message": f"Opened: {abs_path}", "path": abs_path, "count": count}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/open-output-folder")
async def open_output_folder():
    """Open the output listings folder"""
    try:
        abs_path = open_folder_with_explorer(OUTPUT_FOLDER)
        folder_count = len([f for f in os.listdir(OUTPUT_FOLDER) if os.path.isdir(os.path.join(OUTPUT_FOLDER, f))])
        return {"message": f"Opened: {abs_path}", "path": abs_path, "count": folder_count}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        await websocket.send_json({"type": "state", "data": state.to_dict()})
        while True:
            data = await websocket.receive_json()
            if data.get("type") == "start":
                if not state.is_running:
                    asyncio.create_task(run_pipeline())
            elif data.get("type") == "stop":
                state.should_stop = True
            elif data.get("type") == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        manager.disconnect(websocket)


@app.post("/api/save-item")
async def save_item(update: ItemUpdate):
    """Save edited item metadata and description back to folder"""
    try:
        item_path = os.path.normpath(update.item_folder)
        if not os.path.exists(item_path):
            raise HTTPException(status_code=404, detail="Item folder not found")

        metadata_dir = os.path.join(item_path, "metadata")
        os.makedirs(metadata_dir, exist_ok=True)

        data = {
            "title": update.title,
            "brand": update.brand,
            "size": update.size,
            "condition": update.condition,
            "material": update.material,
            "color": update.color,
            "measurements": update.measurements,
            "visible_flaws": update.visible_flaws,
            "description": update.description
        }

        ItemMetadata.save_as_json(data, metadata_dir)
        ItemMetadata.save_listing_description(update.description, metadata_dir)
        ItemMetadata.save_listing_description(update.description, item_path)
        ItemMetadata.save_as_text(data, metadata_dir)

        for i, item in enumerate(state.extracted_data):
            if os.path.normpath(item.get("output_folder", "")) == item_path:
                state.extracted_data[i] = {**item, **data}
                break

        await manager.broadcast_state()
        add_log(f"Saved changes for {update.title}", "success")
        return {"status": "success", "message": "Item updated successfully"}
    except Exception as e:
        logger.error(f"Error saving item: {e}")
        add_log(f"Failed to save changes: {str(e)}", "error")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/item-photo")
async def get_item_photo(path: str):
    """Serve photo from path with robust resolution"""
    try:
        normalized = os.path.normpath(path)
        if os.path.exists(normalized) and os.path.isfile(normalized):
            return FileResponse(normalized)

        clean_path = path.replace("\\", "/").lstrip("./")
        abs_path = os.path.join(BASE_DIR, clean_path)
        if os.path.exists(abs_path) and os.path.isfile(abs_path):
            return FileResponse(abs_path)

        output_basename = os.path.basename(OUTPUT_FOLDER)
        if output_basename not in clean_path:
            alt_path = os.path.join(OUTPUT_FOLDER, clean_path)
            if os.path.exists(alt_path) and os.path.isfile(alt_path):
                return FileResponse(alt_path)
        else:
            parts = clean_path.split("/")
            try:
                idx = parts.index(output_basename)
                sub_path = os.path.join(*parts[idx + 1:])
                final_alt = os.path.join(OUTPUT_FOLDER, sub_path)
                if os.path.exists(final_alt) and os.path.isfile(final_alt):
                    return FileResponse(final_alt)
            except ValueError:
                pass

        logger.warning(f"Photo not found: {path}")
        raise HTTPException(status_code=404, detail="Photo not found")
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        logger.error(f"Error serving photo: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/item-photo")
async def delete_item_photo(path: str):
    """Delete photo from path and update metadata if possible"""
    try:
        normalized_path = os.path.normpath(path)
        if not os.path.exists(normalized_path):
            alt_path = os.path.join(OUTPUT_FOLDER, normalized_path)
            if os.path.exists(alt_path):
                normalized_path = alt_path
            else:
                raise HTTPException(status_code=404, detail="Photo not found")

        filename = os.path.basename(normalized_path)
        parent_dir = os.path.dirname(normalized_path)
        relative_parent = os.path.relpath(parent_dir, OUTPUT_FOLDER)
        trash_dir = os.path.join(OUTPUT_FOLDER, ".trash", datetime.now().strftime("%Y%m%d"), str(uuid.uuid4()), relative_parent)
        os.makedirs(trash_dir, exist_ok=True)
        trash_path = os.path.join(trash_dir, filename)
        shutil.move(normalized_path, trash_path)

        metadata_json = os.path.join(parent_dir, "metadata", "vendora_data.json")
        if not os.path.exists(metadata_json):
            metadata_json = os.path.join(parent_dir, "vendora_data.json")

        removed_index = None
        removed_type = None
        removed_caption = None

        if os.path.exists(metadata_json):
            try:
                with open(metadata_json, "r", encoding="utf-8") as f:
                    data = json.load(f)

                if "images" in data and filename in data["images"]:
                    idx = data["images"].index(filename)
                    removed_index = idx
                    data["images"].pop(idx)
                    if "image_types" in data and len(data["image_types"]) > idx:
                        removed_type = data["image_types"].pop(idx)
                    if "image_captions" in data and len(data["image_captions"]) > idx:
                        removed_caption = data["image_captions"].pop(idx)

                    with open(metadata_json, "w", encoding="utf-8") as f:
                        json.dump(data, f, indent=4)

                for item in state.extracted_data:
                    if os.path.normpath(item.get("output_folder", "")) == os.path.normpath(parent_dir):
                        if filename in item.get("images", []):
                            f_idx = item["images"].index(filename)
                            item["images"].pop(f_idx)
                            if "image_types" in item and len(item["image_types"]) > f_idx:
                                item["image_types"].pop(f_idx)
                            if "image_captions" in item and len(item["image_captions"]) > f_idx:
                                item["image_captions"].pop(f_idx)
                        break
            except Exception as meta_e:
                logger.error(f"Failed to update metadata during deletion: {meta_e}")

        add_log(f"Deleted image: {filename}", "warning")
        await manager.broadcast_state()
        return {
            "status": "success",
            "message": "Image deleted",
            "undo": {
                "trash_path": trash_path,
                "original_path": normalized_path,
                "parent_dir": parent_dir,
                "filename": filename,
                "index": removed_index,
                "removed_type": removed_type,
                "removed_caption": removed_caption
            }
        }
    except Exception as e:
        logger.error(f"Error deleting photo: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/item-photo/restore")
async def restore_item_photo(payload: RestorePhotoRequest):
    """Restore previously deleted photo and reinsert metadata."""
    try:
        if not os.path.exists(payload.trash_path):
            raise HTTPException(status_code=404, detail="Deleted photo backup not found")

        os.makedirs(os.path.dirname(payload.original_path), exist_ok=True)
        shutil.move(payload.trash_path, payload.original_path)

        metadata_json = os.path.join(payload.parent_dir, "metadata", "vendora_data.json")
        if not os.path.exists(metadata_json):
            metadata_json = os.path.join(payload.parent_dir, "vendora_data.json")

        if os.path.exists(metadata_json):
            with open(metadata_json, "r", encoding="utf-8") as f:
                data = json.load(f)

            images = data.get("images", [])
            insert_idx = payload.index if payload.index is not None else len(images)
            insert_idx = max(0, min(insert_idx, len(images)))
            images.insert(insert_idx, payload.filename)
            data["images"] = images

            if "image_types" in data and isinstance(data["image_types"], list):
                image_types = data["image_types"]
                if payload.removed_type is not None:
                    idx = max(0, min(insert_idx, len(image_types)))
                    image_types.insert(idx, payload.removed_type)

            if "image_captions" in data and isinstance(data["image_captions"], list):
                image_captions = data["image_captions"]
                if payload.removed_caption is not None:
                    idx = max(0, min(insert_idx, len(image_captions)))
                    image_captions.insert(idx, payload.removed_caption)

            with open(metadata_json, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=4)

        for item in state.extracted_data:
            if os.path.normpath(item.get("output_folder", "")) == os.path.normpath(payload.parent_dir):
                images = item.get("images", [])
                insert_idx = payload.index if payload.index is not None else len(images)
                insert_idx = max(0, min(insert_idx, len(images)))
                images.insert(insert_idx, payload.filename)
                item["images"] = images

                if "image_types" in item and isinstance(item["image_types"], list) and payload.removed_type is not None:
                    idx = max(0, min(insert_idx, len(item["image_types"])))
                    item["image_types"].insert(idx, payload.removed_type)
                if "image_captions" in item and isinstance(item["image_captions"], list) and payload.removed_caption is not None:
                    idx = max(0, min(insert_idx, len(item["image_captions"])))
                    item["image_captions"].insert(idx, payload.removed_caption)
                break

        add_log(f"Restored image: {payload.filename}", "success")
        await manager.broadcast_state()
        return {"status": "success", "message": "Image restored"}
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        logger.error(f"Error restoring photo: {e}")
        raise HTTPException(status_code=500, detail=str(e))


def signal_handler(signum, frame):
    """Handle shutdown signals gracefully"""
    logger.info(f"Received signal {signum}, shutting down...")
    state.should_stop = True
    sys.exit(0)


@app.on_event("startup")
async def startup_event():
    load_state_from_disk()


if __name__ == "__main__":
    import uvicorn

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    uvicorn.run(app, host="0.0.0.0", port=8000)
