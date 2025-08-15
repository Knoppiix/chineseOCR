const { app, BrowserWindow, ipcMain, screen, Menu, dialog, Tray } = require('electron');
const screenshot = require('screenshot-desktop');
const path = require('path');
const Jimp = require('jimp');
const { spawn, exec } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const psTree = require('ps-tree');

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
let selectionWindows = []; // Array to hold references to all selection windows
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
const startPythonApi = async () => {
  console.log('Starting Python API server...');
  try {
    pythonProcess = spawn('python', ['main.py'], {
      cwd: path.join(__dirname, 'python-api'),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true  // This is important for Windows compatibility
    });

    // Handle process errors
    pythonProcess.on('error', (err) => {
      console.error('Failed to start Python process:', err);
      pythonProcess = null;
      throw err;
    });

    // Buffer to collect stderr
    let stderrBuffer = '';
    
    pythonProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log(`Python API stdout: ${output}`);
    });

    pythonProcess.stderr.on('data', (data) => {
      const errorOutput = data.toString();
      console.error(`Python API stderr: ${errorOutput}`);
      stderrBuffer += errorOutput;
    });

    // Wait for the process to either exit or start successfully
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (stderrBuffer.includes('Application startup complete')) {
          resolve();
        } else {
          reject(new Error('Python server failed to start: ' + stderrBuffer));
        }
      }, 10000); // 10 second timeout

      pythonProcess.once('exit', (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(new Error(`Python process exited with code ${code}: ${stderrBuffer}`));
        } else {
          resolve();
        }
      });
    });

    console.log('Python API server started successfully');
    return true;
  } catch (error) {
    console.error('Error starting Python API server:', error);
    if (pythonProcess) {
      try {
        await stopPythonApi();
      } catch (e) {
        console.error('Error while cleaning up after failed start:', e);
      }
    }
    throw error;
  }
};

// Function to stop the Python API server
const stopPythonApi = async () => {
  if (!pythonProcess) return;

  console.log('Stopping Python API server...');

  try {
    process.kill(pythonProcess.pid, 'SIGINT');
  } catch (e) {
    console.error('Failed to kill Python process:', e);
  } finally {
    pythonProcess = null;
  }
};

// Function to send image buffer to the OCR API
const sendToOcrApi = async (imageBuffer, originalImageBuffer, isFullScreen = false) => {
  try {
    const form = new FormData();
    form.append('file', imageBuffer, {
      filename: 'screenshot.png',
      contentType: 'image/png',
    });

    console.log('Sending screenshot to OCR API...');
    const response = await axios.put('http://127.0.0.1:62965/ocr', form, {
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
  mainWindow.webContents.openDevTools();

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

const takeFullScreenshot = async (electronDisplayId = null) => {
  try {
    const displays = await screenshot.listDisplays();
    let targetDisplayId = null;

    if (electronDisplayId) {
      const electronDisplays = screen.getAllDisplays();
      const matchingElectronDisplay = electronDisplays.find(d => d.id === electronDisplayId);
      if (matchingElectronDisplay) {
        const screenshotDisplay = displays.find(sd => 
          sd.left === matchingElectronDisplay.bounds.x &&
          sd.top === matchingElectronDisplay.bounds.y &&
          sd.width === matchingElectronDisplay.bounds.width &&
          sd.height === matchingElectronDisplay.bounds.height
        );
        if (screenshotDisplay) {
          targetDisplayId = screenshotDisplay.id;
        }
      }
    } else {
      // Default to primary display if no specific ID is provided
      const primaryElectronDisplay = screen.getPrimaryDisplay();
      const screenshotDisplay = displays.find(sd => 
        sd.left === primaryElectronDisplay.bounds.x &&
        sd.top === primaryElectronDisplay.bounds.y &&
        sd.width === primaryElectronDisplay.bounds.width &&
        sd.height === primaryElectronDisplay.bounds.height
      );
      if (screenshotDisplay) {
        targetDisplayId = screenshotDisplay.id;
      }
    }

    if (!targetDisplayId) {
      console.error('Could not determine target display ID for full screenshot.');
      // Fallback to default screenshot behavior if ID cannot be determined
      await screenshot({ format: 'png' }).then((img) => {
        console.log('Full screenshot taken (fallback).');
        sendToOcrApi(img, img);
      });
      return;
    }

    await screenshot({ format: 'png', screen: targetDisplayId }).then((img) => {
      console.log('Full screenshot taken.');
      sendToOcrApi(img, img);
    });
  } catch (err) {
    console.error('Failed to take full screenshot', err);
  }
};

const selectRegionScreenshot = async () => {
  const displays = screen.getAllDisplays();
  const screenshotDisplays = await screenshot.listDisplays();

  displays.forEach(electronDisplay => {
    const { x, y, width, height, id: electronDisplayId } = electronDisplay.bounds;

    // Find the corresponding screenshot-desktop display ID
    const matchingScreenshotDisplay = screenshotDisplays.find(sd => 
      sd.left === x && sd.top === y && sd.width === width && sd.height === height
    );

    if (!matchingScreenshotDisplay) {
      console.warn(`No matching screenshot-desktop display found for Electron display ID: ${electronDisplayId}`);
      return; // Skip this display if no match is found
    }

    const selectionWindow = new BrowserWindow({
      x,
      y,
      width,
      height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
      show: false // Keep the window hidden until it's ready
    });

    selectionWindow.once('ready-to-show', () => {
      selectionWindow.webContents.send('display-id', matchingScreenshotDisplay.id); // Send screenshot-desktop ID
      selectionWindow.show();
    });

    selectionWindow.loadFile('src/selection.html');
    selectionWindows.push(selectionWindow);

    selectionWindow.on('closed', () => {
      selectionWindows = selectionWindows.filter(win => win !== selectionWindow);
    });
  });
};


ipcMain.on('screenshot:region', async (event, { rect, displayId }) => {
  if (!displayId) {
    console.error('Received screenshot:region event with undefined displayId.');
    return;
  }

  // The displayId received here is already the screenshot-desktop format
  try {
    const img = await screenshot({ screen: displayId, format: 'png' });
    const image = await Jimp.read(img);
    const buffer = await image.crop(rect.x, rect.y, rect.width, rect.height).getBufferAsync(Jimp.MIME_PNG);
    console.log('Region screenshot taken and cropped.');
    sendToOcrApi(buffer, buffer, false);
  } catch (err) {
    console.error('Failed to take region screenshot', err);
  }
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

ipcMain.on('selection:done', () => {
  selectionWindows.forEach(win => {
    if (!win.isDestroyed()) {
      win.close();
    }
  });
  selectionWindows = []; // Clear the array after closing all windows
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
  startPythonApi()
  .then(() => console.log('Server started'))
  .catch(err => console.error('Failed to start server:', err));
  createWindow();

  // NOTE: You'll need to create an icon file named 'icon.png' in the root of your project.
  const iconPath = path.join(__dirname, 'icon.png');
  if (fs.existsSync(iconPath)) {
      tray = new Tray(iconPath);
      const contextMenu = Menu.buildFromTemplate([
        { label: 'Take Full Screenshot', click: () => takeFullScreenshot(screen.getPrimaryDisplay().id) },
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