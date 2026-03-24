"""
AI Client for LM Studio / Qwen3.5 VL - Handles all communication with multimodal models
Supports Qwen VL (Vision Language) models for image understanding

Enhanced with:
- Master AI Prompt for vintage clothing classification
- Image type classification (FULL_FRONT_FLATLAY vs DETAIL_SHOT)
- Enhanced prompts with metadata/time context for better accuracy
- Better JSON parsing with multiple fallback strategies
"""

import requests
import logging
import json
import time
import base64
import re
from typing import List, Dict, Optional, Tuple, Callable
from datetime import datetime

from config import LM_STUDIO_BASE_URL, MODEL_NAME, API_TIMEOUT, MAX_RETRIES, RETRY_DELAY

logger = logging.getLogger(__name__)


class LMStudioClient:
    """Client for interacting with LM Studio's local API"""
    
    def __init__(self, base_url: str = LM_STUDIO_BASE_URL, model: Optional[str] = None):
        self.base_url = base_url.rstrip('/')
        self.model = model or MODEL_NAME
        self.timeout = API_TIMEOUT
        
    def _make_request(self, payload: dict) -> dict:
        """Make API request with retry logic"""
        url = f"{self.base_url}/chat/completions"
        
        for attempt in range(MAX_RETRIES):
            try:
                response = requests.post(
                    url,
                    json=payload,
                    timeout=self.timeout
                )
                
                if response.status_code == 400:
                    logger.error(f"400 Error Response: {response.text[:500]}")
                    raise Exception(f"API Error 400: {response.text[:200]}")
                
                response.raise_for_status()
                return response.json()
                    
            except requests.exceptions.Timeout:
                logger.warning(f"Request timeout (attempt {attempt + 1}/{MAX_RETRIES})")
                if attempt < MAX_RETRIES - 1:
                    time.sleep(RETRY_DELAY)
                    
            except requests.exceptions.RequestException as e:
                logger.error(f"Request failed: {e}")
                if attempt < MAX_RETRIES - 1:
                    time.sleep(RETRY_DELAY)
                else:
                    raise
        
        raise Exception("Max retries exceeded")
    
    def check_connection(self) -> bool:
        """Test connection to LM Studio server"""
        try:
            response = requests.get(f"{self.base_url}/models", timeout=10)
            return response.status_code == 200
        except Exception as e:
            logger.error(f"Connection check failed: {e}")
            return False



class ImageClassifier:
    """
    Classifies clothing images using the Master AI Prompt.
    Determines if an image is FULL_FRONT_FLATLAY or DETAIL_SHOT.
    """
    
    CLASSIFICATION_PROMPT = """You are an expert vintage clothing appraiser analyzing images for a marketplace.

Do TWO things:
1. Classify the image_type:
   - FULL_FRONT_FLATLAY: The entire garment is visible from the front, laid flat
   - DETAIL_SHOT: A close-up of a neck tag, wash label, tape measure, zipper, flaw, or the back of the garment

2. Write a detailed, data-rich caption (max 40 words) that EXTRACTS EXACT DATA from the photo. You MUST transcribe numbers and text precisely:
   - Tape measure: State the ORIENTATION (Horizontal or Vertical). Look for the fabric's edge. Pink numbers are tens. State "Horizontal/Vertical tape measure showing [Number]cm".
   - Brand/size tag: Transcribe EXACT text and ALWAYS NOTE IF IT IS A KIDS/YOUTH SIZE (e.g. "Neck tag reading [Brand] Size [Size] [Years/Specs]").
   - Care/wash label: Transcribe materials exactly as listed, e.g. "Care label showing [X]% [Material] [Y]% [Material]".
   - Flaw: Describe specifically, e.g. "[Description] [Size] on [Location]"
   - Front view: State color, type, and any visible logo, e.g. "[Color] [Item] with [Logo] on [Location]"
   - Back view: Note what is visible, e.g. "Back view showing [Visuals/Text]"
   
    CRITICAL DATA EXTRACTION RULES (STRICT VISUAL ANALYSIS):
    - ONLY DESCRIBE what is clearly visible in THIS image.
    - DO NOT ASSUME consistency with other images.
    - DO NOT GUESS or autocomplete brand names. Only state the brand if clearly readable on a tag.
    - MEASUREMENTS ONLY if a ruler or measuring tape is clearly visible. If no ruler is visible, DO NOT output any measurements.
    - FINGERS/HANDS: IGNORE any fingers or hands holding/pointing to the garment.
    - MEASURE AT EDGE: Read the ruler exactly where the garment material ends and the background begins.
    - RULER SCALE: Pink numbers represent the tens digit (10, 20, 30, etc). Read the black markings after the pink number to get the precise value. (e.g., Pink [X] mark + units [Y] = [XY]cm).
   
   NEVER write vague captions like "tape measure showing measurement".

Respond with ONLY a valid JSON object:
{"image_type": "FULL_FRONT_FLATLAY" or "DETAIL_SHOT", "caption": "your data-rich caption"}"""

    def __init__(self, client: LMStudioClient):
        self.client = client
    
    def classify(self, image_b64: str) -> Tuple[str, str]:
        """
        Classify a single image AND generate a caption in ONE call.
        Returns (image_type, caption)
        """
        content = [
            {"type": "text", "text": self.CLASSIFICATION_PROMPT},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}}
        ]
        
        messages = [{"role": "user", "content": content}]
        
        payload = {
            "model": self.client.model,
            "messages": messages,
            "max_tokens": 150,
            "temperature": 0.1
        }
        
        try:
            response = self.client._make_request(payload)
            raw = response['choices'][0]['message']['content'].strip()
            
            # Parse JSON response
            data = self._parse_json(raw)
            image_type = data.get('image_type', 'UNKNOWN')
            caption = data.get('caption', 'No caption')
            
            return image_type, caption
            
        except Exception as e:
            logger.error(f"Classification failed: {e}")
            return 'UNKNOWN', 'Classification failed'
    
    def _parse_json(self, text: str) -> dict:
        """Parse JSON from text with fallback"""
        cleaned = text.strip()
        import re
        if cleaned.startswith('```'):
            match = re.search(r'\{.*\}', cleaned, re.DOTALL)
            if match:
                cleaned = match.group()
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            match = re.search(r'\{.*?"image_type".*?\}', cleaned, re.DOTALL)
            if match:
                try:
                    return json.loads(match.group())
                except json.JSONDecodeError:
                    pass
        return {'image_type': 'UNKNOWN', 'caption': 'Could not parse'}


import re


class GarmentGrouper:
    """
    Phase 1: Groups images by garment using AI comparison.
    Uses metadata (timestamps, filenames) to help determine if garments are different.
    
    Enhanced with:
    - Timestamp parsing from filenames (format: YYYYMMDD_HHMMSS)
    - Confidence scoring
    - Smart re-evaluation for quick succession shots
    """
    
    GROUPING_PROMPT = """You are an expert vintage clothing appraiser organizing photos.

TASK: Determine if Image 2 (New Photo) shows the EXACT SAME physical garment as Image 1 (Reference Anchor).
Image 1 is ALWAYS the very first photo taken of a garment (the true anchor).

CRITICAL RULES:

1. TIMING THRESHOLDS:
   - The time gap reflects how long since the seller took the previous photo.
   - Within 60 seconds: Very likely SAME garment.
   - Over 60 seconds: Be extremely cautious. Sellers often pause between garments.
   - Over 90 seconds: Strong signal they are DIFFERENT garments.

2. BRAND AND ANCHOR COMPARISON:
   - Image 1 is the ANCHOR (usually the Front).
   - If Image 2 shows a different brand logo than Image 1 => NO.
   - If Image 2 shows the BACK of a garment (no logo) and the time gap is < 60s => YES (it is a logical flip).
   - If Image 2 shows a NEW FRONT shot with a different logo or style => NO.

3. FRONT/BACK TRANSITIONS:
   - It is perfectly normal for a garment session to include a front shot (Anchor) followed by a BACK shot.
   - The BACK often lacks the logo/branding found on the front.
   - If the color, shape, and fabric match AND the time gap is < 60s, assume it's the SAME garment's back.

4. COLOR AND TYPE ALONE ARE NOT ENOUGH:
   - "Both are red hoodies" is NOT sufficient evidence of sameness if the time gap > 60s! 
   - Lean toward DIFFERENT (NO) ONLY if the time gap is long OR the brands clearly conflict.
   - If the time gap is < 30s, lean toward SAME (YES) even for front-to-back flips.

CONFIDENCE SCORING:
- 90-100%: Same brand/logo strictly confirmed OR clear front/back flip with < 30s gap.
- 75-89%: Timing < 60s, visually identical style.
- 50-74%: Timing > 60s, conservative guess.

OUTPUT FORMAT (CRITICAL):
You MUST choose ONLY ONE of the following exact formats. Do NOT output the literal string "YES|NO" and do not include markdown blocks.

If you decide they are the SAME:
YES|CONFIDENCE:95%|REASON:your brief explanation here

If you decide they are DIFFERENT:
NO|CONFIDENCE:95%|REASON:your brief explanation here
"""
    
    def __init__(self, client: LMStudioClient):
        self.client = client
        self.min_pixels = 256 * 28 * 28
        self.max_pixels = 2048 * 28 * 28
        self.time_threshold_seconds = 60  # Re-evaluate if less than 60 seconds
    
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
    
    def _format_time_context(self, time_diff_seconds: float) -> str:
        """Format time difference for prompt context"""
        if time_diff_seconds < 0:
            return "Unknown (no timestamp available)"
        elif time_diff_seconds < 30:
            return f"{int(time_diff_seconds)} seconds (VERY RAPID - strong same garment signal)"
        elif time_diff_seconds < 60:
            return f"{int(time_diff_seconds)} seconds (rapid succession - likely SAME)"
        elif time_diff_seconds < 120:
            return f"~{int(time_diff_seconds)} seconds (~2 minutes - could be same or different)"
        elif time_diff_seconds < 300:
            minutes = int(time_diff_seconds // 60)
            return f"{minutes} minute(s) - moderate gap"
        else:
            minutes = int(time_diff_seconds // 60)
            return f"{minutes} minutes (significant gap - likely DIFFERENT)"
    
    def _get_timestamp_analysis(self, ref_filename: str, test_filename: str, time_diff_seconds: float) -> str:
        """Analyze timestamps from filenames and file system"""
        ref_dt = self._parse_timestamp_from_filename(ref_filename)
        test_dt = self._parse_timestamp_from_filename(test_filename)
        
        analysis_parts = []
        
        if ref_dt and test_dt:
            filename_diff = (test_dt - ref_dt).total_seconds()
            if filename_diff < 0:
                analysis_parts.append("⚠️ Filenames out of order")
            elif filename_diff < 60:
                analysis_parts.append(f"✅ Filenames: {int(filename_diff)}s apart (SAME garment likely)")
            else:
                analysis_parts.append(f"📅 Filenames: {int(filename_diff)}s apart")
        else:
            analysis_parts.append("❓ Could not parse timestamps from filenames")
        
        if time_diff_seconds >= 0:
            if time_diff_seconds < 60:
                analysis_parts.append(f"⚡ File mtime: {int(time_diff_seconds)}s (VERY FAST)")
            else:
                analysis_parts.append(f"⏱️ File mtime: {int(time_diff_seconds)}s")
        
        return " | ".join(analysis_parts)
    
    def _extract_photo_context(self, filename: str) -> str:
        """Extract hints from filename about photo type"""
        filename_lower = filename.lower()
        hints = []
        
        if any(x in filename_lower for x in ['detail', 'close', 'zoom', 'tag', 'label', 'closeup']):
            hints.append("close-up/detail")
        if any(x in filename_lower for x in ['back', 'rear']):
            hints.append("back view")
        if any(x in filename_lower for x in ['side']):
            hints.append("side view")
        if any(x in filename_lower for x in ['front', 'main']):
            hints.append("front view")
            
        return ", ".join(hints) if hints else "standard"
    
    def are_same_garment_with_context(
        self,
        ref_image_b64: str,
        test_image_b64: str,
        ref_filename: str,
        test_filename: str,
        time_diff_seconds: float,
        min_pixels: Optional[int] = None,
        max_pixels: Optional[int] = None,
        known_brand: Optional[str] = None,
        prev_filename: Optional[str] = None
    ) -> Tuple[bool, str, float]:
        """
        Compare two images with metadata context to determine if same garment.
        Returns: (is_same, reasoning_with_confidence, confidence_score)
        
        Args:
            known_brand: If provided, this is the brand of the reference garment.
                        When a FULL_FRONT shows a different brand, they are different garments.
        """
        
        time_context = self._format_time_context(time_diff_seconds)
        # Use prev_filename if provided, otherwise fallback to ref_filename
        compare_against_filename = prev_filename if prev_filename else ref_filename
        timestamp_analysis = self._get_timestamp_analysis(compare_against_filename, test_filename, time_diff_seconds)
        ref_context = self._extract_photo_context(ref_filename)
        test_context = self._extract_photo_context(test_filename)
        
        # Add brand context to prompt if known
        brand_context = ""
        if known_brand:
            brand_context = f"""
            
BRAND CONTEXT (CRITICAL):
- The reference garment is known to be: {known_brand}
- When comparing to a FULL_FRONT image showing a DIFFERENT brand → Answer NO
- Same style/color but different brand = DIFFERENT GARMENTS"""
        
        # Enhanced prompt with extracted context
        timing_rules = """
CRITICAL RULE ON TIMING & FALSE POSITIVES (READ CAREFULLY):
Sellers photograph one single garment rapidly (usually 5-30 seconds apart). 
If the time gap between photos is GREATER than 60 seconds, it almost CERTAINLY means the seller put away the old garment and grabbed a NEW ONE.
Even if the current image looks VISUALLY IDENTICAL (e.g. back of a red hoodie vs front of a different red hoodie), a large time gap (>60s) means they are DIFFERENT items. Answer NO unconditionally in these cases unless you have absolute proof otherwise!
"""
        prompt = f"""You are an expert vintage clothing appraiser. {self.GROUPING_PROMPT}{brand_context}{timing_rules}

IMAGE INFORMATION:
- Reference: {ref_filename} (type: {ref_context})
- Current: {test_filename} (type: {test_context})

TIMING ANALYSIS:
{timestamp_analysis}

Look at both images carefully. Consider:
1. Garment identity (color, brand, style, fabric)
2. Photo timing (rapid succession = same garment)
3. View angle (details vs full front)

OUTPUT FORMAT: "YES|NO|CONFIDENCE:XX%|REASON:brief explanation"

Your decision:"""
        
        content = [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{ref_image_b64}"}},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{test_image_b64}"}}
        ]
        
        messages = [{"role": "user", "content": content}]
        
        payload = {
            "model": self.client.model,
            "messages": messages,
            "max_tokens": 150,
            "temperature": 0.1
        }
        
        try:
            response = self.client._make_request(payload)
            answer = response['choices'][0]['message']['content'].strip()
            
            # Parse response: "YES|NO|CONFIDENCE:85%|REASON:..."
            parts = answer.split('|')
            decision = parts[0] if parts else "UNKNOWN"
            
            # Extract confidence
            confidence = 0.0
            for part in parts:
                if 'CONFIDENCE:' in part:
                    try:
                        conf_str = part.split(':')[1].replace('%', '')
                        confidence = float(conf_str)
                    except:
                        confidence = 50.0
                    break
            
            is_same = decision.upper() == "YES"
            
            logger.info(f"Comparison: {decision} (conf: {confidence:.1f}%) - {ref_filename} → {test_filename}")
            logger.info(f"  Time diff: {time_diff_seconds:.1f}s, Reason: {parts[-1] if len(parts) > 2 else 'N/A'}")
            
            return is_same, answer, confidence
            
        except Exception as e:
            logger.error(f"Comparison failed: {e}")
            # Fail-safe: assume same garment on error to avoid losing images
            return True, f"ERROR: {str(e)}", 0.0



class VendoraExtractor:
    """
    Phase 2: Extracts Vendora listing data from garment images using Master AI Prompt.
    
    Enhanced with:
    - Master AI Prompt for vintage clothing classification
    - Image type classification (FULL_FRONT_FLATLAY vs DETAIL_SHOT)
    - Clear field extraction guidelines
    - Measurement reading instructions
    - Condition grading scale
    - JSON output validation
    """
    
    # Master AI Prompt for data extraction
    EXTRACTION_PROMPT = """You are an expert vintage clothing appraiser and data extraction assistant processing images for a marketplace database.

Look at the uploaded image. Your task is to analyze this specific image and return a strict JSON object. Do not guess information. If a detail is not clearly visible in this exact image, you MUST return null for that field.

STEP 1: Classify the Image
Determine the image_type. It must be exactly one of these two options:

FULL_FRONT_FLATLAY: The entire garment is visible from the front, laid flat.

DETAIL_SHOT: A close-up of a neck tag, wash label, tape measure, zipper, flaw, or the back of the garment.

STEP 2: Extract Visible Data
Look for the following information. Again, if it is not in the image, output null.

item_type: What the garment is (e.g., Hoodie, Denim Jeans, T-Shirt). Usually best seen in flatlays.

color: The primary color of the garment.

brand: The brand name, usually found on neck tags or logos.

size: The tagged size (e.g., M, Large, 32x34).

material: Fabric composition (e.g., 100% Cotton, Polyester), usually on wash tags.

measurement_cm: If a tape measure is visible, read the exact centimeter measurement it points to. If none, output null.

condition_notes: Describe any visible flaws, stains, or holes. If there are NO visible flaws, stains, or holes, output exactly 'None'. Do not output 'Flawless' or 'null' if there are no flaws, just output 'None'.

CRITICAL RULE:
Output ONLY a valid JSON object. Do not include markdown formatting (like ```json), conversational text, or explanations.

Required JSON Structure:
{
"image_type": "FULL_FRONT_FLATLAY" or "DETAIL_SHOT",
"item_type": "string" or null,
"color": "string" or null,
"brand": "string" or null,
"size": "string" or null,
"material": "string" or null,
"measurement_cm": "string" or null,
"condition_notes": "string" or null
}"""

    def __init__(self, client: LMStudioClient):
        self.client = client
        self.min_pixels = 512 * 28 * 28  # Higher resolution for detail extraction
        self.max_pixels = 2048 * 28 * 28
    
    def extract_single(self, image_b64: str) -> dict:
        """
        Extract data from a single image using Master AI Prompt.
        Returns dict with image_type, item_type, color, brand, size, material, measurement_cm, condition_notes
        """
        content = [
            {"type": "text", "text": self.EXTRACTION_PROMPT},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}}
        ]
        
        messages = [{"role": "user", "content": content}]
        
        payload = {
            "model": self.client.model,
            "messages": messages,
            "max_tokens": 300,
            "temperature": 0.2
        }
        
        try:
            response = self.client._make_request(payload)
            raw_response = response['choices'][0]['message']['content']
            
            # Parse JSON response
            data = self._parse_json_response(raw_response)
            return self._validate_extraction(data)
            
        except Exception as e:
            logger.error(f"Extraction failed: {e}")
            return self._get_error_data(str(e))
    
    BATCH_EXTRACTION_PROMPT = """You are an expert vintage fashion cataloger. 
I am providing you with multiple images of the EXACT SAME garment from different angles.
Some images show the whole garment (flatlay/front), others show close-ups of labels, tags, cuffs, or flaws.

Your task is to synthesize all this visual information into ONE single JSON object.

CRITICAL INSTRUCTIONS:
- STRICT VISUAL ANALYSIS: Only describe what is clearly visible in the provided images.
- MEASUREMENTS ONLY if a ruler/tape is clearly visible. If no ruler is visible in ANY image, leave `measurement_cm` as null.
- REASONABILITY CHECK: Measurements must be human-sized (e.g. Pit-to-Pit 30-75cm, Length 40-95cm). If a number is illogical (like 120cm), it is a misread—DO NOT output it.
- BRAND CONSISTENCY: Pick the most readable/certain brand name seen across images. NEVER guess or autocomplete (e.g. do not turn "Marc Cain" into "Marc by Marco").
- EXPERT RULER READING: Pink/Red numbers = 10s. HORIZONTAL = P2P, VERTICAL = Length.
- TAG WARNING: NEVER extract P2P/Length from neck tags (height specs).
- KIDS/YOUTH SIZING: Reflect "Youth [Size] ([X] Yrs)" if tags indicate kids' sizing.
- MATERIAL CONFLICTS: Prefer the most specific/detailed tag.
- FINGERS/HANDS: IGNORE them.
- CONDITION MAPPING: Use ONLY: 'Like New', 'Excellent', 'Good', 'Gently Used'.
- FLAW REDIRECTION: Move flaws to `condition_notes`.
- SIZE NORMALIZATION: ONLY apply this if the tagged size is purely numeric (e.g., "48", "32", "12").
  * If the size is already a letter (S, M, L, XL, XXL, XS) or contains letters, DO NOT add any normalization - keep it exactly as written.
  * For numeric sizes, provide the closest letter size equivalent (S-XXL). Format as: "[Numeric] (≈ [Letter])".
  * European sizes: 44≈S, 46≈M, 48≈L, 50≈XL, 52≈XXL, 54≈3XL, 56≈4XL
  * US/Men waist: 28≈XS, 30≈S, 32≈M, 34≈L, 36≈XL, 38≈XXL, 40≈3XL
  * US Women: 0-2≈XS, 4-6≈S, 8-10≈M, 12-14≈L, 16-18≈XL, 20-22≈XXL
  * Kids/Juniors: 2≈XS, 3≈S, 4≈M, 5≈L, 6≈XL, 7≈XXL
  * UK: 6≈XS, 8≈S, 10≈M, 12≈L, 14≈XL, 16≈XXL
  * Examples: "48 (≈ L)", "50 (≈ XL)", "32 (≈ M)", "3 (≈ S)", "12 (≈ L)"
  * If it's a range (e.g. "48-50"), pick the midpoint and normalize: "49 (≈ L/XL)".

Required JSON Structure (ONLY include fields with confirmed info):
{
  "item_type": "string" or null,
  "color": "string" or null,
  "brand": "string" or null,
  "size": "string" or null,
  "material": "string" or null,
  "measurement_cm": "string (P2P: [X]cm, Length: [Y]cm) or null",
  "condition_notes": "string" or null
}
(NOTE: If material or size is unknown, leave as null. DO NOT use placeholders like [X] or unknown.)
"""

    def extract_data(
        self, 
        image_batch_b64: List[str],
        image_captions: List[str] = None
    ) -> dict:
        """
        Extract Vendora listing data from multiple images in one holistic AI pass.
        Solves the context dilution issue by letting the model see all tags and flatlays simultaneously.
        """
        # Cap to 8 images to prevent LM Studio OOM (Out-of-memory) on typical GPUs
        process_batch = image_batch_b64[:8]
        
        prompt_text = self.BATCH_EXTRACTION_PROMPT
        if image_captions:
            captions_list = "\n".join(f"- {c}" for c in image_captions)
            prompt_text += f"\n\nHere are the EXACT facts extracted from these images (use these as GROUND TRUTH):\n{captions_list}"
        
        content = [{"type": "text", "text": prompt_text}]
        for b64 in process_batch:
            content.append({
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{b64}"}
            })
            
        messages = [{"role": "user", "content": content}]
        payload = {
            "model": self.client.model,
            "messages": messages,
            "max_tokens": 500,
            "temperature": 0.1
        }
        
        # We don't catch the exception here so that main.py can trigger its manual-review fallback correctly
        response = self.client._make_request(payload)
        raw_response = response['choices'][0]['message']['content']
        
        data = self._parse_json_response(raw_response)
        data = self._validate_extraction(data)
        
        # Reconstruct title from raw data
        brand = data.get('brand')
        brand_val = brand if brand and brand not in ('Unknown', 'null', None) else 'Vintage'
        item_type = data.get('item_type')
        item_val = item_type if item_type and item_type not in ('Unknown', 'null', None) else 'Garment'
        color = data.get('color')
        color_val = color if color and color not in ('Unknown', 'null', None) else ''
        
        title = f"{brand_val} {item_val} — {color_val}".strip(' —')
        data['title'] = title
            
        return data

    def generate_ai_description(self, item_data: dict, captions: List[str]) -> str:
        """
        Use Qwen to fill in the user's exact listing template.
        This is a TEXT-ONLY call (no images) so it's extremely fast.
        
        Args:
            item_data: The extracted metadata JSON from extract_data
            captions: List of per-image captions from the classify step
        """
        # Build context from structured data + captions
        captions_text = "\n".join(f"- Photo {i+1}: {c}" for i, c in enumerate(captions))
        
        prompt = f"""You are a professional Vendora/Vinted marketplace copywriter.

Here is the extracted metadata for a garment:
- Brand: {item_data.get('brand', 'Unknown')}
- Item Type: {item_data.get('item_type', 'Unknown')}
- Color: {item_data.get('color', 'Unknown')}
- Size: {item_data.get('size', 'Unknown')}
- Material: {item_data.get('material', 'Unknown')}
- Measurements: {item_data.get('measurement_cm', 'Not available')}
- Condition Notes: {item_data.get('condition_notes', 'None')}

Here is what each photo shows:
{captions_text}

Using ONLY the information above (do NOT invent details), fill in this EXACT template. 
 
CRITICAL DATA RULES:
1. CAPTIONS ARE THE GROUND TRUTH: If a photo caption contains exact numbers (e.g. "[X]% Cotton" or "[Y]cm Length"), those values MUST override any other automated guesses.
2. HORIZONTAL = P2P: If a caption mentions a "Horizontal" tape measure, map that number ONLY to Pit-to-Pit.
3. VERTICAL = LENGTH: If a caption mentions a "Vertical" tape measure, map that number ONLY to Length.
4. NO TAG SIZES FOR MEASUREMENTS: NEVER use numbers from a neck tag as Pit-to-Pit or Length.
5. COMPOSITION CONFLICTS: If tags conflict, use the most specific one. Transcribe materials exactly (e.g. "[X]% [Material], [Y]% [Material]").
6. "OTHER" Measurements: If there are additional measurements like "Sleeve", list them in the [Other] field.
7. OMIT EMPTY FIELDS: If there are NO 'Other' measurements, COMPLETELY DELETE the `[Other]:` line from the template. Do not write "None" or "Not measured".
8. CONDITION MAPPING: Most items should be 'Excellent' or 'Perfect' unless there are VISIBLE PILLING, COLOR LOSS/FADING, or SIGNIFICANT flaws. Use ONLY these terms: 'Like New', 'Excellent', 'Good', 'Gently Used'.
   - EXCELLENT/PERFECT: No visible flaws, pilling, or color loss - like new or barely used
   - GOOD: Minor signs of wear that are barely noticeable
   - GENTLY USED: Visible pilling, slight color fading, or other moderate wear
   - Do NOT use 'Gently Used' for minor stains that are hidden/detachable - those go in the description
9. FLAW REDIRECTION: If there are flaws (stains, holes) in the 'Condition Notes', do NOT list them in the 'Condition:' line of the metadata. Instead, weave them into the 'About the Piece' or 'Key Detail' section.
 
Write creative but honest copy for the "About the Piece", "Style Note" and "Key Detail" sections based on the metadata.

---TEMPLATE START---
# (Note: This description was automatically generated for your convenience. Please refer to the photos for full accuracy on condition and measurements.)

[Brand] [Item Name/Model] — [Color]
Brand: [Brand Name]
Size: [Size Info]
Condition: [Condition Level]
Composition: [Material Mix]
Color: [Color]

Measurements (Laid Flat):
Pit-to-Pit: [P2P]
Length: [Length]
[Other]: [Other Measurement]

About the Piece
[Vibe Description]

Style Note: [Suggest Aesthetic]

Key Detail: [Hardware/Unique Feature]

Seller Notes
Shipping: 🚀 Next day shipping guaranteed!

Shop My Closet: Check out my other offers for more [Brand] items—I'm happy to offer bundle discounts if you see something else you like!

Questions? Drop a comment or send an offer. I'm responsive and ready to ship.
---TEMPLATE END---

Output ONLY the filled template. No extra commentary."""

        messages = [{"role": "user", "content": prompt}]
        payload = {
            "model": self.client.model,
            "messages": messages,
            "max_tokens": 600,
            "temperature": 0.3
        }
        
        try:
            response = self.client._make_request(payload)
            result = response['choices'][0]['message']['content'].strip()
            # Strip template markers if AI included them
            result = result.replace('---TEMPLATE START---', '').replace('---TEMPLATE END---', '').strip()
            return result
        except Exception as e:
            logger.error(f"AI description generation failed: {e}")
            # Fallback to a basic template
            brand_val = item_data.get('brand', 'Vintage')
            return f"{item_data.get('title', 'Vintage Garment')}\nBrand: {brand_val}\nCondition: Good\n\nPlease review photos for details."
    
    def _combine_extractions(self, extractions: List[dict], image_types: List[str], image_batch_b64: List[str] = None) -> dict:
        """
        Combine extractions from multiple images into a single listing.
        
        Strategy:
        - item_type: Take from FULL_FRONT if available, else first non-null
        - color: Take from FULL_FRONT if available, else first non-null
        - brand: Take first non-null found
        - size: Take first non-null found
        - material: Take first non-null found
        - measurements: Collect all non-null measurements
        - condition_notes: Combine all non-null notes
        - description: Generate from all extracted data
        """
        combined = {
            "title": "Unknown Item",
            "brand": "Unknown",
            "size": "Unknown",
            "measurements": {},
            "condition": "Unknown",
            "material": "Unknown",
            "color": "Unknown",
            "visible_flaws": "None",
            "description": "",
            "image_types": image_types,
            "all_extractions": extractions
        }
        
        # Find best item_type from FULL_FRONT images
        full_front_items = [e.get('item_type') for e in extractions 
                          if e.get('image_type') == 'FULL_FRONT_FLATLAY' and e.get('item_type')]
        if full_front_items:
            combined['item_type'] = full_front_items[0]
        else:
            # Take first non-null
            for e in extractions:
                if e.get('item_type'):
                    combined['item_type'] = e['item_type']
                    break
        
        # Find best color from FULL_FRONT images
        full_front_colors = [e.get('color') for e in extractions 
                           if e.get('image_type') == 'FULL_FRONT_FLATLAY' and e.get('color')]
        if full_front_colors:
            combined['color'] = full_front_colors[0]
        else:
            for e in extractions:
                if e.get('color'):
                    combined['color'] = e['color']
                    break
        
        # Brand - take first non-null
        for e in extractions:
            if e.get('brand'):
                combined['brand'] = e['brand']
                break
        
        # Size - take first non-null
        for e in extractions:
            if e.get('size'):
                combined['size'] = e['size']
                break
        
        # Material - take first non-null
        for e in extractions:
            if e.get('material'):
                combined['material'] = e['material']
                break
        
        # Measurements - collect all
        measurements = []
        for e in extractions:
            if e.get('measurement_cm'):
                measurements.append(e['measurement_cm'])
        if measurements:
            combined['measurements']['all_measurements'] = measurements
        
        # Condition - combine all notes
        flaw_notes = []
        for e in extractions:
            notes = e.get('condition_notes')
            if notes and notes.lower() != 'null' and notes != 'None':
                flaw_notes.append(notes)
        
        if flaw_notes:
            combined['visible_flaws'] = "; ".join(flaw_notes)
            # Determine overall condition
            if any('stain' in n.lower() or 'hole' in n.lower() or 'tear' in n.lower() for n in flaw_notes):
                combined['condition'] = 'Fair'
            else:
                combined['condition'] = 'Good'
        else:
            combined['condition'] = 'Excellent'
        
        # Build title: "Brand Color ItemType Size"
        title_parts = []
        if combined['brand'] != 'Unknown':
            title_parts.append(combined['brand'])
        if combined['color'] != 'Unknown':
            title_parts.append(combined['color'])
        if combined['item_type'] != 'Unknown':
            title_parts.append(combined['item_type'])
        if combined['size'] != 'Unknown':
            title_parts.append(combined['size'])
        
        combined['title'] = " ".join(title_parts) if title_parts else "Unknown Item"
        
        # Build description from all available data
        desc_parts = []
        if combined['brand'] != 'Unknown':
            desc_parts.append(f"Brand: {combined['brand']}")
        if combined['item_type'] != 'Unknown':
            desc_parts.append(f"Type: {combined['item_type']}")
        if combined['color'] != 'Unknown':
            desc_parts.append(f"Color: {combined['color']}")
        if combined['size'] != 'Unknown':
            desc_parts.append(f"Size: {combined['size']}")
        if combined['material'] != 'Unknown':
            desc_parts.append(f"Material: {combined['material']}")
        if combined['measurements']:
            meas_str = ", ".join([f"{k}: {v}" for k, v in combined['measurements'].items()])
            desc_parts.append(f"Measurements: {meas_str}")
        if combined['visible_flaws'] and combined['visible_flaws'] != 'None':
            desc_parts.append(f"Condition notes: {combined['visible_flaws']}")
        
        combined['description'] = " | ".join(desc_parts) if desc_parts else "No description available"
        
        # Generate enhanced marketplace listing description with AI-generated vibe
        combined['enhanced_description'] = self._generate_enhanced_description(combined, image_batch_b64)
        
        return combined
    
    # Prompt for generating the "vibe" description from all images
    VIBE_DESCRIPTION_PROMPT = """You are a fashion copywriter creating compelling marketplace listings. Based on the images provided, write a 2-3 sentence "vibe" description that captures:
- The silhouette and overall look
- The weight and feel of the fabric
- Any unique details (distressing, embroidery, hardware, labels, etc.)
- Style suggestions (how to wear it)

Be evocative but honest. Do not make up information not visible in the images.

Return ONLY the description text, no quotes or formatting markers."""
    
    def _generate_enhanced_description(self, data: dict, image_batch_b64: List[str]) -> str:
        """
        Generate a compelling marketplace listing description following the format:
        [Brand] [Item Name/Model] — [Color]
        Brand: [Insert Brand]
        Size: [Insert Size] (Fits [True to Size / Oversized / Small])
        Condition: [e.g., Brand New / Gently Used]
        Composition: [e.g., 100% Cashmere / Heavyweight Denim]
        Color: [Insert Color]

        Measurements (Laid Flat):
        Pit-to-Pit: [Measurement]
        Length: [Measurement]
        [Other]: [e.g., Waist/Inseam/Sleeve]

        About the Piece
        [AI-generated 2-3 sentence vibe description]

        Style Note: [e.g., Perfect for a clean-girl aesthetic or layering over a hoodie.]

        Key Detail: [e.g., Features a reinforced collar and hidden side-seam pockets.]

        Seller Notes
        Shipping: 🚀 Next day shipping guaranteed!

        Shop My Closet: Check out my other offers for more [Brand/Style] items—I'm happy to offer bundle discounts if you see something else you like!

        Questions? Drop a comment or send an offer. I'm responsive and ready to ship.
        """
        brand = data.get('brand', '')
        item_type = data.get('item_type', '')
        color = data.get('color', '')
        size = data.get('size', '')
        material = data.get('material', '')
        condition = data.get('condition', 'Gently Used')
        flaws = data.get('visible_flaws', '')
        measurements = data.get('measurements', {}).get('all_measurements', [])
        
        # Build header line
        if brand and item_type:
            header = f"{brand} {item_type}"
            if color:
                header += f" — {color}"
        elif item_type:
            header = item_type
            if color:
                header += f" — {color}"
        else:
            header = "Vintage Item"
        
        # Build structured description
        lines = []
        lines.append(header)
        lines.append("")
        
        # Basic info section
        if brand:
            lines.append(f"Brand: {brand}")
        if size:
            # Try to determine fit from size (this is heuristic)
            fit = "True to Size"
            if size.upper() in ['XL', 'XXL', 'L/G', 'Oversized']:
                fit = "Oversized"
            elif size.upper() in ['XS', 'S', 'S/M']:
                fit = "Small"
            lines.append(f"Size: {size} (Fits {fit})")
        lines.append(f"Condition: {condition}")
        if material:
            lines.append(f"Composition: {material}")
        if color:
            lines.append(f"Color: {color}")
        
        lines.append("")
        lines.append("Measurements (Laid Flat):")
        
        # Measurements - use what we have
        if measurements:
            unique_meas = list(dict.fromkeys(measurements))
            if len(unique_meas) >= 2:
                lines.append(f"Pit-to-Pit: {unique_meas[0]} cm")
                lines.append(f"Length: {unique_meas[1]} cm")
            elif len(unique_meas) == 1:
                lines.append(f"Pit-to-Pit: {unique_meas[0]} cm")
                lines.append(f"Length: {unique_meas[0]} cm")
        else:
            lines.append("Pit-to-Pit: - cm")
            lines.append("Length: - cm")
        
        lines.append("")
        lines.append("About the Piece")
        
        # Try to generate vibe description using AI on all images
        vibe = self._generate_vibe_description(image_batch_b64, data)
        lines.append(vibe)
        
        # Style note
        lines.append("")
        lines.append("Style Note: Perfect for elevating any outfit. Great for layering or wearing as a statement piece.")
        
        # Key details from extracted data
        if flaws and flaws != 'None':
            lines.append(f"Key Detail: {flaws}")
        else:
            lines.append("Key Detail: Authentic piece in excellent condition with no visible flaws.")
        
        lines.append("")
        lines.append("Seller Notes")
        lines.append("Shipping: 🚀 Next day shipping guaranteed!")
        
        if brand and brand != 'Unknown':
            lines.append(f"Shop My Closet: Check out my other {brand} items—I'm happy to offer bundle discounts!")
        else:
            lines.append("Shop My Closet: Check out my other vintage items—I'm happy to offer bundle discounts!")
        
        lines.append("")
        lines.append("Questions? Drop a comment or send an offer. I'm responsive and ready to ship.")
        
        return "\n".join(lines)
    
    def _generate_vibe_description(self, image_batch_b64: List[str], data: dict) -> str:
        """
        Use AI to generate an evocative 2-3 sentence description of the item
        based on all the images. This captures the "vibe" that can't be easily templated.
        """
        if not image_batch_b64:
            return "A timeless vintage piece with character and style. Perfect addition to any wardrobe."
        
        try:
            # Build content with all images and the vibe prompt
            content = [{"type": "text", "text": self.VIBE_DESCRIPTION_PROMPT}]
            
            # Add up to 4 images to keep request manageable
            for img_b64 in image_batch_b64[:4]:
                content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{img_b64}"}})
            
            messages = [{"role": "user", "content": content}]
            
            payload = {
                "model": self.client.model,
                "messages": messages,
                "max_tokens": 200,
                "temperature": 0.7
            }
            
            response = self.client._make_request(payload)
            vibe_text = response['choices'][0]['message']['content'].strip()
            
            # Clean up the response - remove quotes if present
            if vibe_text.startswith('"') and vibe_text.endswith('"'):
                vibe_text = vibe_text[1:-1]
            if vibe_text.startswith("'" ) and vibe_text.endswith("'"):
                vibe_text = vibe_text[1:-1]
            
            return vibe_text
            
        except Exception as e:
            logger.error(f"Failed to generate vibe description: {e}")
            # Fallback vibe based on extracted data
            brand = data.get('brand', '')
            item_type = data.get('item_type', 'piece')
            color = data.get('color', '')
            
            fallback = f"A stylish {brand} {item_type}" if brand else f"A vintage {item_type}"
            if color:
                fallback += f" in {color}"
            fallback += " that adds a touch of sophistication to any look. Well-crafted with quality materials."
            return fallback
    
    def _parse_json_response(self, raw_response: str) -> dict:
        """Parse JSON from response with multiple fallback strategies"""
        cleaned = raw_response.strip()
        import re
        
        # Strategy 1: Direct parse
        try:
            # First try just removing markdown code blocks if present
            if cleaned.startswith('```'):
                match = re.search(r'\{.*\}', cleaned, re.DOTALL)
                if match:
                    return json.loads(match.group())
            return json.loads(cleaned)
        except Exception:
            pass
            
        # Strategy 2: Extract first { to last } using greedy regex
        match = re.search(r'(\{.*\})', cleaned, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(1))
            except Exception:
                pass
                
        raise ValueError(f"Could not parse JSON from response: {raw_response[:200]}")
    
    def _validate_extraction(self, data: dict) -> dict:
        """Ensure extraction has all expected fields"""
        expected = ['image_type', 'item_type', 'color', 'brand', 'size', 'material', 'measurement_cm', 'condition_notes']
        for field in expected:
            if field not in data:
                data[field] = None
        return data
    
    def _get_error_data(self, error_msg: str) -> dict:
        """Return error state data"""
        return {
            "image_type": None,
            "item_type": None,
            "color": None,
            "brand": None,
            "size": None,
            "material": None,
            "measurement_cm": None,
            "condition_notes": f"Extraction failed: {error_msg}"
        }


def create_ai_client() -> Tuple[LMStudioClient, GarmentGrouper, VendoraExtractor]:
    """Create and return all AI client components"""
    client = LMStudioClient()
    grouper = GarmentGrouper(client)
    extractor = VendoraExtractor(client)
    return client, grouper, extractor


def create_full_ai_client() -> Tuple[LMStudioClient, ImageClassifier, GarmentGrouper, VendoraExtractor]:
    """Create all AI client components including the new ImageClassifier"""
    client = LMStudioClient()
    classifier = ImageClassifier(client)
    grouper = GarmentGrouper(client)
    extractor = VendoraExtractor(client)
    return client, classifier, grouper, extractor
