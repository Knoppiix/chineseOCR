package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"unicode"
)

// App struct
type App struct {
	ctx context.Context
}

type OCRItem struct {
	Text        string          `json:"text"`
	Confidence  float64         `json:"confidence"`
	BoundingBox json.RawMessage `json:"bounding_box"`
}

type OCRResponse struct {
	Result []OCRItem `json:"result"`
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// Greet returns a greeting for the given name
func (a *App) ReqAPI(imgPath string) string {
	file, err := os.Open(imgPath)
	if err != nil {
		panic(err)
	}
	defer file.Close()

	api_endpoint := "http://localhost:62965/ocr"
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("file", "ocrImage.jpg")
	if err != nil {
		panic(err)
	}
	_, err = io.Copy(part, file)
	if err != nil {
		panic(err)
	}
	writer.Close()
	// Forge HTTP Put request to the API endpoint
	req, err := http.NewRequest("PUT", api_endpoint, body)
	if err != nil {
		panic(err)
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())
	// Send the request
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		panic(err)
	}
	defer resp.Body.Close()
	// Retrieve the response
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		panic(err)
	}
	text, err := parseOCRText([]byte(string(respBody)))
	if err != nil {
		panic(err)
	}
	return text
}

// ParseOCRText parses the JSON and returns concatenated recognized text
func parseOCRText(jsonData []byte) (string, error) {
	var ocrResp OCRResponse
	err := json.Unmarshal(jsonData, &ocrResp)
	if err != nil {
		return "", err
	}

	text := ""
	for _, item := range ocrResp.Result {
		rune := []rune(item.Text)
		for _, r := range rune {
			// We're parsing chinese characters (hanzi) out from the string
			if unicode.Is(unicode.Han, r) {
				text += string(r)
			}
		}
	}

	return text, nil
}
