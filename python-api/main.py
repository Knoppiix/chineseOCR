from fastapi import FastAPI, UploadFile, HTTPException, File, Request
from fastapi.responses import JSONResponse
from paddleocr import PaddleOCR
import os
import mimetypes
import tempfile
from typing import List, Dict, Union, Any
from pydantic import BaseModel
from pathlib import Path

# Global dictionary for Chinese words
chinese_dictionary = set()

def load_dictionary():
    dict_path = Path(__file__).parent.parent / "cedict_1_0_ts_utf-8_mdbg.txt"
    if not dict_path.exists():
        print(f"Dictionary file not found at {dict_path}")
        return
    
    with open(dict_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#'):
                parts = line.split(' ')
                if len(parts) >= 2:
                    simplified_char = parts[1]
                    chinese_dictionary.add(simplified_char)
    print(f"Loaded {len(chinese_dictionary)} words from dictionary.")

def merge_bounding_boxes(boxes):
    if not boxes:
        return []
    
    min_x = min(min(p[0] for p in box) for box in boxes)
    min_y = min(min(p[1] for p in box) for box in boxes)
    max_x = max(max(p[0] for p in box) for box in boxes)
    max_y = max(max(p[1] for p in box) for box in boxes)
    
    return [
        [min_x, min_y],
        [max_x, min_y],
        [max_x, max_y],
        [min_x, max_y]
    ]

def segment_text(ocr_results):
    segmented_words = []
    i = 0
    while i < len(ocr_results):
        best_match = ""
        best_match_idx = -1
        
        # Try to find the longest match from the current position
        for j in range(i, len(ocr_results)):
            current_segment = "".join([ocr_results[k].text for k in range(i, j + 1)])
            if current_segment in chinese_dictionary:
                best_match = current_segment
                best_match_idx = j
        
        if best_match_idx != -1:
            # Found a word in the dictionary
            word_text = best_match
            word_confidence = sum([ocr_results[k].confidence for k in range(i, best_match_idx + 1)]) / len(word_text)
            word_boxes = [ocr_results[k].bounding_box for k in range(i, best_match_idx + 1)]
            merged_box = merge_bounding_boxes(word_boxes)
            segmented_words.append(OCRResult(
                text=word_text,
                confidence=word_confidence,
                bounding_box=merged_box
            ))
            i = best_match_idx + 1
        else:
            # No match found, treat the current character as a single word
            segmented_words.append(ocr_results[i])
            i += 1
            
    return segmented_words

# Call load_dictionary at startup
load_dictionary()
from pathlib import Path

app = FastAPI(
    title="Chinese OCR API",
    description="API for performing OCR on Chinese text in images using PaddleOCR"
)

# Initialize PaddleOCR
# ocr = PaddleOCR(use_angle_cls=True, lang='ch', return_word_box=True, rec_model_dir='./PP-OCRv4_mobile_rec_infer')

ocr = PaddleOCR(
    ocr_version='PP-OCRv4',
#    use_angle_cls=True,
#    use_gpu=False,
    lang='ch',
#    use_doc_orientation_classify=False,
    use_textline_orientation=False,
#    return_word_box=True
)

# Maximum allowed file size (100MB)
MAX_FILE_SIZE = 100 * 1024 * 1024

# Allowed file types
ALLOWED_MIME_TYPES = {'image/png', 'image/jpeg', 'image/gif'}

class OCRResult(BaseModel):
    text: str
    confidence: float
    bounding_box: List[List[int]]

class OCRResponse(BaseModel):
    result: List[OCRResult]

@app.put("/ocr", response_model=OCRResponse)
async def perform_ocr(request: Request, file: UploadFile = File(...)) -> OCRResponse:
    # Print debug information
    print(f"Request headers: {dict(request.headers)}")
    print(f"File info - Filename: {file.filename}, Content-Type: {file.content_type}")
    
    if not file:
        raise HTTPException(status_code=400, detail="No file uploaded")
        
    # Check file size
    contents = await file.read()
    print(f"File size: {len(contents)} bytes")
    
    if len(contents) > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="File size exceeds the maximum limit")
    
    # Check file type using filename
    mime_type, _ = mimetypes.guess_type(file.filename)
    print(f"Detected MIME type: {mime_type}")
    
    if not mime_type or mime_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(status_code=400, detail="Invalid file type")
    
    # Create a temporary file
    with tempfile.NamedTemporaryFile(delete=False, suffix='.png') as temp_file:
        temp_file.write(contents)
        temp_file_path = temp_file.name

    try:
        # Perform OCR
        result = ocr.ocr(temp_file_path)

        # Process results
        processed_result = []
        if result and result[0]:
            ocr_data = result[0]
            # On Linux, the result can be a single dictionary. On Windows, it's a list of items.
            # This code handles both formats to ensure cross-platform compatibility.
            if isinstance(ocr_data, dict) and 'rec_texts' in ocr_data:
                # Handle the dictionary format (common on Linux)
                num_items = len(ocr_data['rec_texts'])
                for i in range(num_items):
                    text = ocr_data['rec_texts'][i]
                    confidence = ocr_data['rec_scores'][i]
                    box = ocr_data['rec_polys'][i]

                    text_len = len(text)
                    if text_len > 0:
                        p0, p1, p2, p3 = box[0], box[1], box[2], box[3]
                        v_top_x = (p1[0] - p0[0]) / text_len
                        v_top_y = (p1[1] - p0[1]) / text_len
                        v_bottom_x = (p2[0] - p3[0]) / text_len
                        v_bottom_y = (p2[1] - p3[1]) / text_len

                        for j, char_text in enumerate(text):
                            char_p0 = [p0[0] + j * v_top_x, p0[1] + j * v_top_y]
                            char_p1 = [p0[0] + (j + 1) * v_top_x, p0[1] + (j + 1) * v_top_y]
                            char_p3 = [p3[0] + j * v_bottom_x, p3[1] + j * v_bottom_y]
                            char_p2 = [p3[0] + (j + 1) * v_bottom_x, p3[1] + (j + 1) * v_bottom_y]
                            char_box = [char_p0, char_p1, char_p2, char_p3]
                            processed_result.append(OCRResult(
                                text=char_text,
                                confidence=confidence,
                                bounding_box=[[int(coord) for coord in point] for point in char_box]
                            ))
            elif isinstance(ocr_data, list):
                # Handle the list format (common on Windows)
                for item in ocr_data:
                    text = item[1][0]
                    box = item[0]
                    confidence = item[1][1]
                    
                    text_len = len(text)
                    if text_len > 0:
                        p0, p1, p2, p3 = box[0], box[1], box[2], box[3]
                        v_top_x = (p1[0] - p0[0]) / text_len
                        v_top_y = (p1[1] - p0[1]) / text_len
                        v_bottom_x = (p2[0] - p3[0]) / text_len
                        v_bottom_y = (p2[1] - p3[1]) / text_len
                        for i, char_text in enumerate(text):
                            char_p0 = [p0[0] + i * v_top_x, p0[1] + i * v_top_y]
                            char_p1 = [p0[0] + (i + 1) * v_top_x, p0[1] + (i + 1) * v_top_y]
                            char_p3 = [p3[0] + i * v_bottom_x, p3[1] + i * v_bottom_y]
                            char_p2 = [p3[0] + (i + 1) * v_bottom_x, p3[1] + (i + 1) * v_bottom_y]
                            char_box = [char_p0, char_p1, char_p2, char_p3]
                            processed_result.append(OCRResult(
                                text=char_text,
                                confidence=confidence,
                                bounding_box=[[int(coord) for coord in point] for point in char_box]
                            ))

        final_results = segment_text(processed_result)
        return OCRResponse(result=final_results)

    finally:
        # Remove the temporary file
        os.unlink(temp_file_path)

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=62965)
