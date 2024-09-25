from flask import Flask, request, jsonify
from paddleocr import PaddleOCR
from werkzeug.utils import secure_filename
import os
import magic
import tempfile

app = Flask(__name__)

# Initialize PaddleOCR
ocr = PaddleOCR(use_angle_cls=True, lang='ch')

# Maximum allowed file size (5MB)
MAX_FILE_SIZE = 10 * 1024 * 1024

# Allowed file types
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif'}


def allowed_file(filename):
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


@app.route('/ocr', methods=['PUT'])
def perform_ocr():
    # Check if the post request has the file part
    if not request.data:
        return jsonify({'error': 'No file content in the request'}), 400

    # Check file size
    if len(request.data) > MAX_FILE_SIZE:
        return jsonify({'error': 'File size exceeds the maximum limit'}), 400

    # Create a temporary file
    with tempfile.NamedTemporaryFile(delete=False) as temp_file:
        temp_file.write(request.data)
        temp_file_path = temp_file.name

    try:
        # Verify file type
        file_type = magic.from_file(temp_file_path, mime=True)
        if file_type not in ['image/png', 'image/jpeg', 'image/gif']:
            return jsonify({'error': 'Invalid file type'}), 400

        # Perform OCR
        result = ocr.ocr(temp_file_path, cls=True)

        # Process results
        processed_result = []
        for line in result:
            for item in line:
                processed_result.append({
                    'text': item[1][0],
                    'confidence': float(item[1][1]),
                    'bounding_box': item[0]
                })

        return jsonify({'result': processed_result})

    finally:
        # Remove the temporary file
        os.unlink(temp_file_path)


if __name__ == '__main__':
    app.run()
