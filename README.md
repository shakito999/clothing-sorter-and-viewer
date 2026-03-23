# Vendora Auto-Lister

A high-performance AI-powered pipeline designed to process second-hand clothing photos and generate professional, stylized listings ready for Vendora/Vinted. Built with a **FastAPI** backend and a **React** frontend.

## 🚀 The "Blazing Fast" 3-Stage AI Pipeline

This application uses a sophisticated multimodal processing chain optimized for both speed and accuracy.

### Stage 1: Single-Pass Classification & Captioning (Zero extra loops)
As each image is initially processed, the AI performs two tasks in **one** call:
- **Image Categorization**: Determines if it's a `FULL_FRONT_FLATLAY` or a `DETAIL_SHOT`.
- **Image Captioning**: Generates a brief, descriptive tag (e.g., *"Neck tag showing Calvin Klein Jeans size M"*).
- **Output**: Each image in your output folder gets a corresponding `.jpg.txt` caption file.

### Stage 2: Holistic Multi-Image Extraction
Once a garment's images are grouped, the AI analyzes up to 8 images simultaneously (including higher-resolution detail shots at **1024px** for OCR). 
- Extracts structured metadata: Brand, Size, Material, Color, Type, and Measurements.
- Synthesizes information from tags, front views, and close-ups in a single holistic pass to avoid context dilution.

### Stage 3: Stylized Description Generation (Text-only, instant)
A final AI step compiles all structured metadata and image captions into a **stylized listing template**.
- Custom logic creatively fills out "About the Piece," "Style Note," and "Key Detail" sections.
- Ensures a cohesive, professional tone across your entire inventory.

---

## 👕 Smart Garment Grouping

The system intelligently groups your raw photos into individual garments using a combination of visual similarity and **chronological context**:

1. **60-Second Rule**: Photos taken within 60 seconds are highly likely to be the same garment.
2. **Visual Consistency**: High-confidence matching for detail shots (tags, labels, zippers) against their preceding frontal views.
3. **Timing Thresholds**: Gaps over 60 seconds trigger a cautious re-evaluation; gaps over 90 seconds are a strong signal of a new garment.

---

## 📂 Output Structure

Organized, ready-to-list folders are created in `vendora_ready/`:

```
Nike_Air_Hoodie_Black_M_001/
├── 20260309_180146.jpg         # Full-size photos
├── 20260309_180146.jpg.txt     # Single-sentence image caption
├── 20260309_180148.jpg
├── 20260309_180148.jpg.txt
├── description.txt             # Styled, copy-paste ready listing
├── metadata.json               # Full extraction JSON
└── metadata.txt                # Plain-text summary
```

---

## 🛠 Setup & Requirements

### 1. Requirements
- Python 3.10+
- [LM Studio](https://lmstudio.ai/) running a Vision-Language model (e.g., **Qwen 2.5 VL**).
- Node.js for the React frontend.

### 2. Backend Setup
```bash
cd backend
pip install -r requirements.txt
python main.py
```

### 3. Frontend Setup
```bash
cd frontend
npm install
npm run dev
```

### 4. Configuration
Modify `config.py` to set your:
- `LM_STUDIO_BASE_URL` (usually `http://localhost:1234/v1`)
- `INPUT_FOLDER` (your raw photos directory)
- `OUTPUT_FOLDER` (where listing folders are built)

---

## 💡 Best Results Tips

1. **Tag Clarity**: Hold size/composition tags close to the camera as the final extractor will see them at **1024px**.
2. **First Image**: Always start a new garment with a clear, wide-angle front view.
3. **Lighting**: Bright, even lighting significantly improves OCR accuracy for brand and material detection.
4. **Consistency**: Moving quickly (within 60s) between shots of the same garment helps the AI maintain high grouping confidence.

---

## ⚖️ License
MIT - Use freely for your Vendora listings.
