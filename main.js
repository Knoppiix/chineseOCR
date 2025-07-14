const { app, BrowserWindow, ipcMain, screen, Menu, dialog, Tray } = require('electron');
const screenshot = require('screenshot-desktop');
const path = require('path');
const Jimp = require('jimp');
const { spawn } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

// --- Dictionary Logic Start ---
let dictionary = null;

function parseCedict() {
    const cedictPath = path.join(__dirname, 'cedict_1_0_ts_utf-8_mdbg.txt');
    const dictionaryData = fs.readFileSync(cedictPath, 'utf-8');
    const lines = dictionaryData.split(/\r?\n/);
    const parsedDict = new Map();
    let processedLines = 0;
    let failedLines = 0;

    for (const line of lines) {
        processedLines++;
        if (line.startsWith('#') || line.trim() === '') {
            continue;
        }
        const match = line.match(/([^\s]+)\s+([^\s]+)\s+\[([^\]]+)\]\s+\/(.+)\//u);
        if (match) {
            const traditional = match[1];
            const simplified = match[2];
            const pinyin = match[3];
            const english = match[4].split('/').filter(def => def.trim() !== '');
            if (simplified) {
                parsedDict.set(simplified, { pinyin, english });
            }
            if (traditional) {
                parsedDict.set(traditional, { pinyin, english });
            }
        } else {
            failedLines++;
            if (failedLines < 20) { // Log the first 20 failing lines for inspection
                console.log('Did not parse line:', line);
            }
        }
    }
    console.log(`Dictionary parsing complete. Total lines: ${processedLines}, Parsed entries: ${parsedDict.size}, Failed lines: ${failedLines}`);
    return parsedDict;
}

function getDictionary() {
    if (!dictionary) {
        console.log('Loading dictionary...');
        try {
            dictionary = parseCedict();
            console.log(`Dictionary loaded successfully with ${dictionary.size} entries.`);
        } catch (error) {
            console.error('Failed to load or parse the dictionary file:', error);
            dictionary = new Map();
        }
    }
    return dictionary;
}

function translate(word) {
    if (!word) {
        return null;
    }
    const dict = getDictionary();
    return dict.get(word) || null;
}

function findWordsInText(text) {
    const dict = getDictionary();
    const words = [];
    let i = 0;
    while (i < text.length) {
        let foundWord = null;
        for (let j = text.length; j > i; j--) {
            const sub = text.substring(i, j);
            if (dict.has(sub)) {
                foundWord = {
                    text: sub,
                    translation: dict.get(sub),
                    startIndex: i,
                    endIndex: j - 1
                };
                break;
            }
        }
        if (foundWord) {
            words.push(foundWord);
            i = foundWord.endIndex + 1;
        } else {
            i++;
        }
    }
    return words;
}
// --- Dictionary Logic End ---


let mainWindow;
let wordBookWindow;
let pythonProcess = null;
let tray = null;
const wordBookPath = path.join(app.getPath('userData'), 'wordbook.json');

let wordBook = [];

const loadWordBook = () => {
  try {
    if (fs.existsSync(wordBookPath)) {
      const data = fs.readFileSync(wordBookPath, 'utf-8');
      wordBook = JSON.parse(data);
    }
  } catch (error) {
    console.error('Failed to load word book:', error);
  }
};

const saveWordBook = () => {
  try {
    fs.writeFileSync(wordBookPath, JSON.stringify(wordBook, null, 2));
  }
 catch (error) {
    console.error('Failed to save word book:', error);
  }
};

// Function to start the Python API server
const startPythonApi = () => {
  console.log('Starting Python API server...');
  pythonProcess = spawn('python', ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '5000'], {
    cwd: path.join(__dirname, 'python-api'),
    shell: true,
    detached: true
  });

  pythonProcess.stdout.on('data', (data) => {
    console.log(`Python API stdout: ${data}`);
  });

  pythonProcess.stderr.on('data', (data) => {
    console.error(`Python API stderr: ${data}`);
  });

  pythonProcess.on('close', (code) => {
    console.log(`Python API process exited with code ${code}`);
    pythonProcess = null;
  });
};

// Function to stop the Python API server
const stopPythonApi = () => {
  if (pythonProcess) {
    console.log('Stopping Python API server...');
    try {
      // Kill the process group to ensure all child processes are terminated
      process.kill(-pythonProcess.pid, 'SIGKILL');
    } catch (e) {
      console.error('Failed to kill Python process group:', e);
    }
    pythonProcess = null;
  }
};

// Function to send image buffer to the OCR API
const sendToOcrApi = async (imageBuffer, originalImageBuffer) => {
  try {
    const form = new FormData();
    form.append('file', imageBuffer, {
      filename: 'screenshot.png',
      contentType: 'image/png',
    });

    console.log('Sending screenshot to OCR API...');
    const response = await axios.put('http://127.0.0.1:5000/ocr', form, {
      headers: {
        ...form.getHeaders()
      },
    });

    const ocrResult = response.data;
    if (ocrResult && ocrResult.result && Array.isArray(ocrResult.result)) {
        const base64Image = originalImageBuffer.toString('base64');
        if (mainWindow) {
            mainWindow.show();
            mainWindow.webContents.send('ocr:display-results', { image: base64Image, ocrData: ocrResult.result });
        }
    } else {
        console.error('Invalid OCR API response format');
        if (mainWindow) {
            mainWindow.webContents.send('ocr:display-results', { error: 'Error: Invalid API response' });
        }
    }

  } catch (error) {
    if (error.response) {
      console.error('Error from OCR API:', error.response.data);
      if (mainWindow) {
        mainWindow.webContents.send('ocr:display-results', { error: `Error: ${error.response.data.detail || 'API Error'}` });
      }
    } else if (error.request) {
      console.error('No response from OCR API. Is it running?');
      if (mainWindow) {
       mainWindow.webContents.send('ocr:display-results', { error: 'Error: Could not connect to OCR API.' });
      }
    } else {
      console.error('Error setting up OCR request:', error.message);
      if (mainWindow) {
       mainWindow.webContents.send('ocr:display-results', { error: 'Error: Failed to send request.' });
      }
    }
  }
};

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile('src/index.html');
  //mainWindow.webContents.openDevTools();

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
};

const createWordBookWindow = () => {
  if (wordBookWindow) {
    wordBookWindow.show();
    return;
  }
  wordBookWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  wordBookWindow.loadFile('src/wordbook.html');

  wordBookWindow.on('closed', () => {
    wordBookWindow = null;
  });

  wordBookWindow.webContents.on('did-finish-load', () => {
    wordBookWindow.webContents.send('wordbook:data', wordBook);
  });
};

const takeFullScreenshot = () => {
  screenshot({ format: 'png' }).then((img) => {
    console.log('Full screenshot taken.');
    sendToOcrApi(img, img);
  }).catch((err) => {
    console.error('Failed to take full screenshot', err);
  });
};

const selectRegionScreenshot = () => {
  const { width, height } = screen.getPrimaryDisplay().size;
  const selectionWindow = new BrowserWindow({
    x: 0,
    y: 0,
    width,
    height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  selectionWindow.loadFile('src/selection.html');
};

ipcMain.on('screenshot:region', (event, rect) => {
  screenshot({ format: 'png' }).then((img) => {
    Jimp.read(img)
      .then(image => {
        return image.crop(rect.x, rect.y, rect.width, rect.height)
             .getBufferAsync(Jimp.MIME_PNG);
      })
      .then(buffer => {
        console.log('Region screenshot taken and cropped.');
        sendToOcrApi(buffer, buffer);
      })
      .catch(err => {
        console.error('Failed to process region screenshot with Jimp', err);
      });
  }).catch((err) => {
    console.error('Failed to take region screenshot', err);
  });
});

ipcMain.on('wordbook:add', (event, word) => {
  // The 'word' object from the renderer already has the translation
  wordBook.push(word);
  saveWordBook();
});

ipcMain.on('wordbook:export', async () => {
  const csvContent = wordBook.map(item => {    let translation = '';    if (item.translation) {      translation = `[${item.translation.pinyin}] ${item.translation.english.join('; ')}`;    }    return `"${item.text}","${translation}"`;  }).join('\n');


  const { canceled, filePath } = await dialog.showSaveDialog(wordBookWindow, {
    title: 'Export Word Book to Anki',
    defaultPath: 'wordbook.csv',
    filters: [
      { name: 'CSV Files', extensions: ['csv'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (!canceled && filePath) {
    try {
      fs.writeFileSync(filePath, csvContent);
      dialog.showMessageBox(wordBookWindow, {
        type: 'info',
        title: 'Export Successful',
        message: `Word Book exported to ${filePath}`,
      });
    } catch (error) {
      console.error('Failed to export word book:', error);
      dialog.showErrorBox('Export Failed', `Failed to export word book: ${error.message}`);
    }
  }
});

// IPC handlers for translation
ipcMain.handle('translate', (event, word) => {
    return translate(word);
});

ipcMain.handle('find-words', (event, text) => {
    return findWordsInText(text);
});


app.whenReady().then(() => {
  loadWordBook();
  getDictionary(); // Load the dictionary on startup
  startPythonApi();
  createWindow();

  // NOTE: You'll need to create an icon file named 'icon.png' in the root of your project.
  const iconPath = path.join(__dirname, 'icon.png');
  if (fs.existsSync(iconPath)) {
      tray = new Tray(iconPath);
      const contextMenu = Menu.buildFromTemplate([
        { label: 'Take Full Screenshot', click: takeFullScreenshot },
        { label: 'Select Region Screenshot', click: selectRegionScreenshot },
        { label: 'Open Word Book', click: createWordBookWindow },
        { type: 'separator' },
        { label: 'Quit', click: () => {
            app.isQuitting = true;
            app.quit();
          }
        }
      ]);
      tray.setToolTip('OCR Screenshot Tool');
      tray.setContextMenu(contextMenu);
  } else {
      console.error('icon.png not found! Please add an icon to the project root.');
  }

  Menu.setApplicationMenu(null);
});

app.on('before-quit', () => {
  stopPythonApi();
  if (tray) {
    tray.destroy();
  }
});

app.on('window-all-closed', e => e.preventDefault());

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  } else if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
