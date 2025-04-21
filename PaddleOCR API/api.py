from fastapi import FastAPI, UploadFile, HTTPException, File, Request
from fastapi.responses import JSONResponse
from paddleocr import PaddleOCR
import os
import mimetypes
import tempfile
from typing import List, Dict, Union, Any
from pydantic import BaseModel

app = FastAPI(
    title="Chinese OCR API",
    description="API for performing OCR on Chinese text in images using PaddleOCR"
)

# Initialize PaddleOCR
ocr = PaddleOCR(use_angle_cls=True, lang='ch')

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
    with tempfile.NamedTemporaryFile(delete=False) as temp_file:
        temp_file.write(contents)
        temp_file_path = temp_file.name

    try:
        # Perform OCR
        result = ocr.ocr(temp_file_path, cls=True)

        # Process results
        processed_result = []
        if result:  # Check if result is not None
            for line in result:
                for item in line:
                    processed_result.append(OCRResult(
                        text=item[1][0],
                        confidence=float(item[1][1]),
                        bounding_box=[[int(coord) for coord in point] for point in item[0]]
                    ))

        return OCRResponse(result=processed_result)

    finally:
        # Remove the temporary file
        os.unlink(temp_file_path)

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=5000)
