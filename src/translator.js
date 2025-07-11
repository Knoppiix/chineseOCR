const { ipcRenderer } = require('electron');

// This module now acts as a client to the main process for translation services.

/**
 * Asynchronously translates a Chinese word by asking the main process.
 * @param {string} word The Chinese word to translate.
 * @returns {Promise<{pinyin: string, english: string[]} | null>} A promise that resolves with the translation object or null.
 */
async function translate(word) {
    if (!word) {
        return null;
    }
    // Use ipcRenderer.invoke to call the main process and get a promise back
    return await ipcRenderer.invoke('translate', word);
}

/**
 * Asynchronously finds all dictionary words within a given string of text.
 * @param {string} text The text to search.
 * @returns {Promise<Array<{text: string, translation: object, startIndex: number, endIndex: number}>>} A promise that resolves with an array of found words.
 */
async function findWordsInText(text) {
    if (!text) {
        return [];
    }
    return await ipcRenderer.invoke('find-words', text);
}

module.exports = {
    translate,
    findWordsInText
};