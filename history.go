package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"
)

// Learning sessions are archived as JSON next to the config, so a finished
// summary survives closing the window and can be reopened from the History tab.

// SessionWord is one tallied word in a session summary.
type SessionWord struct {
	Word  string `json:"word"`
	Count int    `json:"count"`
	Ms    int64  `json:"ms"`
}

// SessionRecord is a full archived session.
type SessionRecord struct {
	ID      string        `json:"id"`
	SavedAt string        `json:"savedAt"` // RFC3339
	Frames  int           `json:"frames"`
	Words   []SessionWord `json:"words"`
}

// SessionMeta is the lightweight entry shown in the history list.
type SessionMeta struct {
	ID      string `json:"id"`
	SavedAt string `json:"savedAt"`
	Frames  int    `json:"frames"`
	Words   int    `json:"words"`
}

// sessionIDRe guards against path traversal: IDs are our own timestamps.
var sessionIDRe = regexp.MustCompile(`^[0-9]{8}-[0-9]{6}$`)

func sessionsDir() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "ChineseOCR", "sessions"), nil
}

// SaveSessionSummary archives a finished session and returns its ID. Called by
// the frontend once OCR + tallying finish, so every session is kept without the
// user having to export anything.
func (a *App) SaveSessionSummary(frames int, words []SessionWord) (string, error) {
	if len(words) == 0 {
		return "", nil // nothing worth archiving
	}
	dir, err := sessionsDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}

	now := time.Now()
	rec := SessionRecord{
		ID:      now.Format("20060102-150405"),
		SavedAt: now.Format(time.RFC3339),
		Frames:  frames,
		Words:   words,
	}
	data, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, rec.ID+".json"), data, 0o644); err != nil {
		return "", err
	}
	return rec.ID, nil
}

// ListSessions returns archived sessions, newest first.
func (a *App) ListSessions() []SessionMeta {
	out := []SessionMeta{}
	dir, err := sessionsDir()
	if err != nil {
		return out
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return out // no sessions yet
	}
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var rec SessionRecord
		if json.Unmarshal(data, &rec) != nil || rec.ID == "" {
			continue
		}
		out = append(out, SessionMeta{
			ID: rec.ID, SavedAt: rec.SavedAt, Frames: rec.Frames, Words: len(rec.Words),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID > out[j].ID })
	return out
}

// LoadSession reads one archived session back for display.
func (a *App) LoadSession(id string) (SessionRecord, error) {
	var rec SessionRecord
	if !sessionIDRe.MatchString(id) {
		return rec, fmt.Errorf("invalid session id %q", id)
	}
	dir, err := sessionsDir()
	if err != nil {
		return rec, err
	}
	data, err := os.ReadFile(filepath.Join(dir, id+".json"))
	if err != nil {
		return rec, err
	}
	return rec, json.Unmarshal(data, &rec)
}

// DeleteSession removes an archived session.
func (a *App) DeleteSession(id string) error {
	if !sessionIDRe.MatchString(id) {
		return fmt.Errorf("invalid session id %q", id)
	}
	dir, err := sessionsDir()
	if err != nil {
		return err
	}
	return os.Remove(filepath.Join(dir, id+".json"))
}
