const elements = {
  appStatus: document.querySelector("#appStatus"),
  titleInput: document.querySelector("#titleInput"),
  languageSelect: document.querySelector("#languageSelect"),
  noteModeSelect: document.querySelector("#noteModeSelect"),
  audioFileInput: document.querySelector("#audioFileInput"),
  apiSettingsButton: document.querySelector("#apiSettingsButton"),
  apiSettingsPanel: document.querySelector("#apiSettingsPanel"),
  apiSettingsOverlay: document.querySelector("#apiSettingsOverlay"),
  personalApiNoticePanel: document.querySelector("#personalApiNoticePanel"),
  personalApiNoticeOverlay: document.querySelector("#personalApiNoticeOverlay"),
  closePersonalApiNoticeButton: document.querySelector("#closePersonalApiNoticeButton"),
  dismissPersonalApiNoticeButton: document.querySelector("#dismissPersonalApiNoticeButton"),
  openApiSettingsFromNoticeButton: document.querySelector("#openApiSettingsFromNoticeButton"),
  hidePersonalApiNoticeInput: document.querySelector("#hidePersonalApiNoticeInput"),
  closeApiSettingsButton: document.querySelector("#closeApiSettingsButton"),
  usePersonalApiKeyInput: document.querySelector("#usePersonalApiKeyInput"),
  personalApiKeyInput: document.querySelector("#personalApiKeyInput"),
  saveApiSettingsButton: document.querySelector("#saveApiSettingsButton"),
  clearApiSettingsButton: document.querySelector("#clearApiSettingsButton"),
  apiSettingsStatus: document.querySelector("#apiSettingsStatus"),
  historyButton: document.querySelector("#historyButton"),
  historyPanel: document.querySelector("#historyPanel"),
  historyOverlay: document.querySelector("#historyOverlay"),
  closeHistoryButton: document.querySelector("#closeHistoryButton"),
  recordDot: document.querySelector("#recordDot"),
  recordTimer: document.querySelector("#recordTimer"),
  startButton: document.querySelector("#startButton"),
  stopButton: document.querySelector("#stopButton"),
  refreshButton: document.querySelector("#refreshButton"),
  recordList: document.querySelector("#recordList"),
  selectedTitle: document.querySelector("#selectedTitle"),
  selectedMeta: document.querySelector("#selectedMeta"),
  audioPlayer: document.querySelector("#audioPlayer"),
  transcriptArea: document.querySelector("#transcriptArea"),
  noteArea: document.querySelector("#noteArea"),
  copyNoteButton: document.querySelector("#copyNoteButton"),
  exportPdfButton: document.querySelector("#exportPdfButton"),
  exportFilesButton: document.querySelector("#exportFilesButton"),
  saveNoteButton: document.querySelector("#saveNoteButton"),
  recordItemTemplate: document.querySelector("#recordItemTemplate")
};

const state = {
  records: [],
  selectedId: null,
  mediaRecorder: null,
  stream: null,
  chunks: [],
  startedAt: null,
  timerId: null,
  recognition: null,
  finalTranscript: "",
  interimTranscript: "",
  recording: false,
  busy: false,
  aiEnabled: false,
  mode: "server",
  appVariant: "windows",
  historyEnabled: true,
  exportEnabled: false,
  storagePath: "",
  db: null,
  currentAudioObjectUrl: "",
  androidRequests: new Map(),
  usePersonalApiKey: false,
  personalApiKey: "",
  noteMode: "detailed"
};

const LOCAL_DB_NAME = "recording-ai-notes";
const LOCAL_DB_VERSION = 1;
const RECORD_STORE = "records";
const AUDIO_STORE = "audio";
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PERSONAL_API_KEY_STORAGE = "recording-ai-notes.personalApiKey";
const USE_PERSONAL_API_KEY_STORAGE = "recording-ai-notes.usePersonalApiKey";
const HIDE_PERSONAL_API_NOTICE_STORAGE = "recording-ai-notes.hidePersonalApiNotice";
const NOTE_MODE_STORAGE = "recording-ai-notes.noteMode";

elements.startButton.addEventListener("click", startRecording);
elements.stopButton.addEventListener("click", stopRecording);
elements.audioFileInput.addEventListener("change", handleAudioFileSelected);
elements.refreshButton.addEventListener("click", refreshRecords);
elements.historyButton.addEventListener("click", openHistory);
elements.closeHistoryButton.addEventListener("click", closeHistory);
elements.historyOverlay.addEventListener("click", closeHistory);
elements.apiSettingsButton.addEventListener("click", openApiSettings);
elements.closeApiSettingsButton.addEventListener("click", closeApiSettings);
elements.apiSettingsOverlay.addEventListener("click", closeApiSettings);
elements.saveApiSettingsButton.addEventListener("click", saveApiSettings);
elements.clearApiSettingsButton.addEventListener("click", clearApiSettings);
elements.closePersonalApiNoticeButton.addEventListener("click", closePersonalApiNotice);
elements.dismissPersonalApiNoticeButton.addEventListener("click", closePersonalApiNotice);
elements.personalApiNoticeOverlay.addEventListener("click", closePersonalApiNotice);
elements.openApiSettingsFromNoticeButton.addEventListener("click", openApiSettingsFromNotice);
elements.copyNoteButton.addEventListener("click", copyNote);
elements.exportPdfButton.addEventListener("click", exportPdf);
elements.exportFilesButton.addEventListener("click", exportFiles);
elements.saveNoteButton.addEventListener("click", saveCurrentNote);
elements.noteArea.addEventListener("input", updateControls);
elements.noteModeSelect.addEventListener("change", handleNoteModeChanged);

window.onAndroidProcessComplete = (requestId, payload) => {
  const pending = state.androidRequests.get(requestId);

  if (!pending) {
    return;
  }

  state.androidRequests.delete(requestId);

  try {
    pending.resolve(typeof payload === "string" ? JSON.parse(payload) : payload);
  } catch (error) {
    pending.reject(error);
  }
};

window.onAndroidProcessFailed = (requestId, message) => {
  const pending = state.androidRequests.get(requestId);

  if (!pending) {
    return;
  }

  state.androidRequests.delete(requestId);
  pending.reject(new Error(message || "AI処理に失敗しました。"));
};

init();

async function init() {
  loadNoteMode();
  loadApiSettings();
  await loadHealth();
  await refreshRecords();
  updateControls();
  showPersonalApiNoticeIfNeeded();
}

function loadNoteMode() {
  state.noteMode = normalizeNoteMode(localStorage.getItem(NOTE_MODE_STORAGE));
  elements.noteModeSelect.value = state.noteMode;
}

function handleNoteModeChanged() {
  state.noteMode = normalizeNoteMode(elements.noteModeSelect.value);
  elements.noteModeSelect.value = state.noteMode;
  localStorage.setItem(NOTE_MODE_STORAGE, state.noteMode);
}

async function loadHealth() {
  if (shouldUseStandaloneMode()) {
    state.mode = "standalone";
    state.appVariant = hasAndroidBridge() ? "android" : "windows";
    state.aiEnabled = hasAndroidBridge();
    state.historyEnabled = true;
    state.exportEnabled = false;
    state.storagePath = "";
    await initLocalStore();
    await cleanupLocalExpiredAudio();
    setStatus(hasAndroidBridge() ? "スマホ単体モード" : "ローカルモード");
    return;
  }

  try {
    const health = await api("/api/health");
    state.mode = "server";
    state.aiEnabled = Boolean(health.aiEnabled);
    state.appVariant = health.appVariant || "web";
    state.historyEnabled = Boolean(health.historyEnabled);
    state.exportEnabled = Boolean(health.exportEnabled);
    state.storagePath = health.storagePath || "";
  } catch {
    state.mode = "standalone";
    state.appVariant = "windows";
    state.aiEnabled = hasAndroidBridge();
    state.historyEnabled = true;
    state.exportEnabled = false;
    state.storagePath = "";
    await initLocalStore();
    await cleanupLocalExpiredAudio();
    setStatus("ローカルモード");
  }
}

async function startRecording() {
  if (state.recording || state.busy) {
    return;
  }

  if (!canUseDirectRecording()) {
    setStatus("このURLでは直接録音できません。音声ファイルを追加してください。");
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    setStatus("このブラウザでは録音できません。音声ファイルを追加してください。");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    const mimeType = preferredAudioMimeType();
    const mediaRecorder = new MediaRecorder(
      stream,
      mimeType ? { mimeType } : undefined
    );

    state.stream = stream;
    state.mediaRecorder = mediaRecorder;
    state.chunks = [];
    state.finalTranscript = "";
    state.interimTranscript = "";
    state.recording = true;
    state.startedAt = Date.now();
    state.selectedId = null;

    elements.transcriptArea.value = "";
    elements.noteArea.value = "";
    elements.audioPlayer.hidden = true;
    elements.audioPlayer.removeAttribute("src");
    elements.selectedTitle.textContent = "録音中";
    elements.selectedMeta.textContent = "音声を取得中";

    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        state.chunks.push(event.data);
      }
    });
    mediaRecorder.addEventListener("stop", finalizeRecording, { once: true });
    mediaRecorder.start(1000);

    setStatus("録音中");
    startTimer();
    startSpeechRecognition();
    updateControls();
    renderRecordList();
  } catch (error) {
    stopStream();
    state.recording = false;
    setStatus(microphoneErrorMessage(error));
    updateControls();
  }
}

function stopRecording() {
  if (!state.recording || !state.mediaRecorder) {
    return;
  }

  state.recording = false;
  stopSpeechRecognition();
  stopTimer();
  updateControls();
  setStatus("録音を保存中");

  try {
    state.mediaRecorder.stop();
  } catch (error) {
    setStatus(error.message || "停止できませんでした。");
    stopStream();
    updateControls();
  }
}

async function finalizeRecording() {
  const mimeType = state.mediaRecorder?.mimeType || "audio/webm";
  const audioBlob = new Blob(state.chunks, { type: mimeType });
  const browserTranscript = currentTranscript();

  stopStream();
  state.mediaRecorder = null;
  state.chunks = [];
  elements.transcriptArea.value = browserTranscript;

  if (!audioBlob.size) {
    setStatus("録音データが空です。");
    updateControls();
    return;
  }

  setBusy(true);

  try {
    const created = await uploadRecording(audioBlob);
    upsertRecord(created);
    selectRecord(created.id);
    setStatus("文字起こしとノートを作成中");

    const processed = await processRecording(created.id, browserTranscript);
    upsertRecord(processed);
    selectRecord(processed.id);
    setStatus(processed.processingMessage || "完了");
  } catch (error) {
    if (error.data?.id) {
      upsertRecord(error.data);
      selectRecord(error.data.id);
    }

    setStatus(error.message || "処理に失敗しました。");
  } finally {
    setBusy(false);
    await refreshRecords(false);
  }
}

async function uploadRecording(audioBlob, titleOverride = "") {
  const title = titleOverride || elements.titleInput.value.trim();

  if (state.mode === "standalone") {
    return createLocalRecording(audioBlob, title);
  }

  const url = `/api/recordings?title=${encodeURIComponent(title)}`;

  return api(url, {
    method: "POST",
    headers: {
      "Content-Type": audioBlob.type || "audio/webm"
    },
    body: audioBlob
  });
}

async function handleAudioFileSelected(event) {
  const file = event.target.files?.[0];

  if (!file || state.recording || state.busy) {
    return;
  }

  setBusy(true);
  elements.transcriptArea.value = "";
  elements.noteArea.value = "";
  setStatus("音声ファイルを保存中");

  try {
    const title = elements.titleInput.value.trim() || titleFromFile(file.name);
    const created = await uploadRecording(file, title);
    upsertRecord(created);
    selectRecord(created.id);
    setStatus("文字起こしとノートを作成中");

    const processed = await processRecording(created.id, "");
    upsertRecord(processed);
    selectRecord(processed.id);
    setStatus(processed.processingMessage || "完了");
  } catch (error) {
    if (error.data?.id) {
      upsertRecord(error.data);
      selectRecord(error.data.id);
    }

    setStatus(error.message || "処理に失敗しました。");
  } finally {
    event.target.value = "";
    setBusy(false);
    await refreshRecords(false);
  }
}

function processRecording(id, browserTranscript) {
  if (state.mode === "standalone") {
    return processLocalRecording(id, browserTranscript);
  }

  const body = {
    browserTranscript,
    noteMode: state.noteMode
  };
  const personalApiKey = activePersonalApiKey();

  if (personalApiKey) {
    body.userApiKey = personalApiKey;
  }

  return api(`/api/recordings/${encodeURIComponent(id)}/process`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

async function refreshRecords(keepSelection = true) {
  try {
    const selectedId = state.selectedId;

    if (state.mode === "standalone") {
      await cleanupLocalExpiredAudio();
      state.records = await getLocalRecords();
    } else {
      state.records = await api("/api/recordings");
    }

    renderRecordList();

    if (keepSelection && selectedId && state.records.some((item) => item.id === selectedId)) {
      selectRecord(selectedId);
    } else if (!state.selectedId && state.records.length) {
      selectRecord(state.records[0].id);
    }
  } catch (error) {
    setStatus(error.message || "一覧を更新できませんでした。");
  }
}

async function saveCurrentNote() {
  const record = selectedRecord();

  if (!record || state.busy) {
    return;
  }

  setBusy(true);

  try {
    let updated;

    if (state.mode === "standalone") {
      updated = await updateLocalRecording(record.id, {
        title: elements.titleInput.value,
        transcript: elements.transcriptArea.value,
        note: elements.noteArea.value,
        noteMode: state.noteMode
      });
    } else {
      updated = await api(`/api/recordings/${encodeURIComponent(record.id)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          title: elements.titleInput.value,
          transcript: elements.transcriptArea.value,
          note: elements.noteArea.value,
          noteMode: state.noteMode
        })
      });
    }

    upsertRecord(updated);
    selectRecord(updated.id);
    setStatus("履歴に保存しました");
  } catch (error) {
    setStatus(error.message || "保存できませんでした。");
  } finally {
    setBusy(false);
  }
}

async function copyNote() {
  const text = elements.noteArea.value;

  if (!text.trim()) {
    setStatus("コピーするノートが空です。");
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
  } catch {
    elements.noteArea.focus();
    elements.noteArea.select();
    document.execCommand("copy");
  }

  setStatus("ノートをコピーしました");
}

async function exportPdf() {
  const transcript = elements.transcriptArea.value.trim();
  const note = elements.noteArea.value.trim();

  if (!transcript && !note) {
    setStatus("PDFにする内容が空です。");
    return;
  }

  const record = selectedRecord();
  const title = elements.titleInput.value.trim() || record?.title || "録音ノート";
  const createdAt = record?.createdAt ? formatDate(record.createdAt) : formatDate(new Date().toISOString());

  if (state.mode === "standalone") {
    setStatus("PDFダウンロードはWeb版またはWindows版で使えます。");
    return;
  }

  setBusy(true);

  try {
    const response = await fetch("/api/pdf", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title,
        createdAt,
        transcript,
        note,
        noteMode: state.noteMode
      })
    });

    if (!response.ok) {
      let message = "PDFを作成できませんでした。";

      try {
        const data = await response.json();
        message = data.error || message;
      } catch {
        // The response was not JSON.
      }

      throw new Error(message);
    }

    const blob = await response.blob();
    downloadBlob(blob, `${safeFileName(title)}.pdf`);
    setStatus("PDFをダウンロードしました");
  } catch (error) {
    setStatus(error.message || "PDFを作成できませんでした。");
  } finally {
    setBusy(false);
  }
}

async function exportFiles() {
  const record = selectedRecord();

  if (!record || state.busy) {
    return;
  }

  setBusy(true);

  try {
    const exported = await api(`/api/recordings/${encodeURIComponent(record.id)}/export`, {
      method: "POST"
    });
    setStatus(exported.path ? `書き出しました: ${exported.path}` : "ファイルを書き出しました");
  } catch (error) {
    setStatus(error.message || "ファイル保存に失敗しました。");
  } finally {
    setBusy(false);
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function loadApiSettings() {
  state.personalApiKey = localStorage.getItem(PERSONAL_API_KEY_STORAGE) || "";
  state.usePersonalApiKey =
    localStorage.getItem(USE_PERSONAL_API_KEY_STORAGE) === "true" && Boolean(state.personalApiKey);
  syncApiSettingsFields();
}

function syncApiSettingsFields() {
  elements.usePersonalApiKeyInput.checked = state.usePersonalApiKey;
  elements.personalApiKeyInput.value = state.personalApiKey;
  elements.apiSettingsStatus.textContent = apiSettingsMessage();
}

function activePersonalApiKey() {
  return state.usePersonalApiKey ? state.personalApiKey.trim() : "";
}

function apiSettingsMessage() {
  if (activePersonalApiKey()) {
    return "現在は個人APIキーを使います。";
  }

  return state.aiEnabled
    ? "現在は管理者のAPIキーを使います。"
    : "管理者APIキーは未設定です。";
}

async function refreshApiSettingsStatus() {
  if (shouldUseStandaloneMode()) {
    return;
  }

  try {
    const health = await api("/api/health");
    state.mode = "server";
    state.aiEnabled = Boolean(health.aiEnabled);
    state.appVariant = health.appVariant || state.appVariant;
    state.historyEnabled = Boolean(health.historyEnabled);
    state.exportEnabled = Boolean(health.exportEnabled);
    state.storagePath = health.storagePath || "";
  } catch {
    state.aiEnabled = false;
  }
}

async function openApiSettings() {
  syncApiSettingsFields();
  elements.apiSettingsPanel.classList.add("is-open");
  elements.apiSettingsPanel.setAttribute("aria-hidden", "false");
  elements.apiSettingsOverlay.hidden = false;

  if (!activePersonalApiKey() && !shouldUseStandaloneMode()) {
    elements.apiSettingsStatus.textContent = "管理者APIキーを確認中です...";
    await refreshApiSettingsStatus();
    syncApiSettingsFields();
  }
}

function closeApiSettings() {
  elements.apiSettingsPanel.classList.remove("is-open");
  elements.apiSettingsPanel.setAttribute("aria-hidden", "true");
  elements.apiSettingsOverlay.hidden = true;
}

function saveApiSettings() {
  const usePersonal = elements.usePersonalApiKeyInput.checked;
  const apiKey = elements.personalApiKeyInput.value.trim();

  if (usePersonal && !apiKey) {
    elements.apiSettingsStatus.textContent = "個人APIキーを入力してください。";
    return;
  }

  state.usePersonalApiKey = usePersonal;
  state.personalApiKey = apiKey;
  localStorage.setItem(USE_PERSONAL_API_KEY_STORAGE, String(usePersonal));

  if (apiKey) {
    localStorage.setItem(PERSONAL_API_KEY_STORAGE, apiKey);
  } else {
    localStorage.removeItem(PERSONAL_API_KEY_STORAGE);
  }

  syncApiSettingsFields();
  setStatus(activePersonalApiKey() ? "個人APIキーを使います" : "管理者APIキーを使います");
  closeApiSettings();
}

function clearApiSettings() {
  state.usePersonalApiKey = false;
  state.personalApiKey = "";
  localStorage.removeItem(USE_PERSONAL_API_KEY_STORAGE);
  localStorage.removeItem(PERSONAL_API_KEY_STORAGE);
  localStorage.removeItem(HIDE_PERSONAL_API_NOTICE_STORAGE);
  syncApiSettingsFields();
  setStatus("管理者APIキーを使います");
}

function showPersonalApiNoticeIfNeeded() {
  const hidden = localStorage.getItem(HIDE_PERSONAL_API_NOTICE_STORAGE) === "true";

  if (hidden || activePersonalApiKey() || state.mode !== "server") {
    return;
  }

  elements.hidePersonalApiNoticeInput.checked = false;
  elements.personalApiNoticePanel.classList.add("is-open");
  elements.personalApiNoticePanel.setAttribute("aria-hidden", "false");
  elements.personalApiNoticeOverlay.hidden = false;
}

function closePersonalApiNotice() {
  if (elements.hidePersonalApiNoticeInput.checked) {
    localStorage.setItem(HIDE_PERSONAL_API_NOTICE_STORAGE, "true");
  }

  elements.personalApiNoticePanel.classList.remove("is-open");
  elements.personalApiNoticePanel.setAttribute("aria-hidden", "true");
  elements.personalApiNoticeOverlay.hidden = true;
}

function openApiSettingsFromNotice() {
  closePersonalApiNotice();
  openApiSettings();
}

function openHistory() {
  if (!state.historyEnabled) {
    setStatus("Web版では履歴を開けません。Windows版で確認してください。");
    return;
  }

  renderRecordList();
  elements.historyPanel.style.right = "0";
  elements.historyPanel.classList.add("is-open");
  elements.historyPanel.setAttribute("aria-hidden", "false");
  elements.historyOverlay.hidden = false;
}

function closeHistory() {
  elements.historyPanel.style.right = "-420px";
  elements.historyPanel.classList.remove("is-open");
  elements.historyPanel.setAttribute("aria-hidden", "true");
  elements.historyOverlay.hidden = true;
}

function startSpeechRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!Recognition) {
    setStatus(state.aiEnabled ? "録音中: 停止後にAI文字起こしします" : "録音中: AIキーがないため文字起こしできません");
    return;
  }

  const recognition = new Recognition();
  recognition.lang = elements.languageSelect.value;
  recognition.continuous = true;
  recognition.interimResults = true;
  state.recognition = recognition;

  recognition.addEventListener("result", (event) => {
    let finalText = "";
    let interimText = "";

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const transcript = result[0]?.transcript || "";

      if (result.isFinal) {
        finalText += transcript;
      } else {
        interimText += transcript;
      }
    }

    if (finalText) {
      state.finalTranscript = `${state.finalTranscript} ${finalText}`.trim();
    }

    state.interimTranscript = interimText.trim();
    elements.transcriptArea.value = currentTranscript();
  });

  recognition.addEventListener("error", (event) => {
    if (event.error && event.error !== "no-speech") {
      setStatus(state.aiEnabled ? "録音中: 停止後にAI文字起こしします" : `文字起こし: ${event.error}`);
    }
  });

  recognition.addEventListener("end", () => {
    if (!state.recording || state.recognition !== recognition) {
      return;
    }

    window.setTimeout(() => {
      try {
        recognition.start();
      } catch {
        // Browser speech recognition may already be active.
      }
    }, 250);
  });

  try {
    recognition.start();
  } catch {
    setStatus(state.aiEnabled ? "録音中: 停止後にAI文字起こしします" : "録音中: AIキーがないため文字起こしできません");
  }
}

function stopSpeechRecognition() {
  const recognition = state.recognition;
  state.recognition = null;

  if (!recognition) {
    return;
  }

  try {
    recognition.stop();
  } catch {
    // The browser may have already stopped recognition.
  }
}

function startTimer() {
  stopTimer();
  updateTimer();
  state.timerId = window.setInterval(updateTimer, 250);
}

function stopTimer() {
  if (state.timerId) {
    window.clearInterval(state.timerId);
    state.timerId = null;
  }
}

function updateTimer() {
  if (!state.startedAt) {
    elements.recordTimer.textContent = "00:00";
    return;
  }

  const seconds = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  elements.recordTimer.textContent = `${String(minutes).padStart(2, "0")}:${String(
    remainder
  ).padStart(2, "0")}`;
}

function renderRecordList() {
  elements.recordList.textContent = "";

  if (!state.records.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "保存された録音はまだありません。";
    elements.recordList.append(empty);
    return;
  }

  for (const record of state.records) {
    const item = elements.recordItemTemplate.content
      .querySelector(".record-item")
      .cloneNode(true);
    const title = item.querySelector(".record-title");
    const meta = item.querySelector(".record-meta");
    const badge = item.querySelector(".record-badge");
    const openButton = item.querySelector(".record-open");
    const deleteButton = item.querySelector(".record-delete");

    title.textContent = record.title || "無題";
    meta.textContent = `${formatHistoryDate(record.createdAt)} / ${statusLabel(record.status)}`;
    badge.textContent = record.hasAudio
      ? `音声期限 ${formatDate(record.expiresAt)}`
      : "音声削除済み";
    badge.classList.toggle("no-audio", !record.hasAudio);
    item.classList.toggle("is-selected", record.id === state.selectedId);
    openButton.addEventListener("click", () => {
      selectRecord(record.id);
      closeHistory();
    });
    deleteButton.addEventListener("click", () => deleteRecord(record.id));
    elements.recordList.append(item);
  }
}

async function deleteRecord(id) {
  const record = state.records.find((item) => item.id === id);

  if (!record || state.busy) {
    return;
  }

  if (!window.confirm(`「${record.title || "無題"}」を削除しますか？`)) {
    return;
  }

  setBusy(true);

  try {
    if (state.mode === "standalone") {
      await deleteLocalRecording(id);
    } else {
      await api(`/api/recordings/${encodeURIComponent(id)}`, {
        method: "DELETE"
      });
    }

    state.records = state.records.filter((item) => item.id !== id);

    if (state.selectedId === id) {
      clearSelectedRecord();
    }

    renderRecordList();
    setStatus("履歴を削除しました");
  } catch (error) {
    setStatus(error.message || "削除できませんでした。");
  } finally {
    setBusy(false);
  }
}

async function selectRecord(id) {
  const record = state.records.find((item) => item.id === id);

  if (!record) {
    return;
  }

  state.selectedId = record.id;
  elements.selectedTitle.textContent = record.title || "無題";
  elements.selectedMeta.textContent = selectedMeta(record);
  elements.titleInput.value = record.title || "";
  elements.transcriptArea.value = record.transcript || "";
  elements.noteArea.value = record.note || "";
  state.noteMode = normalizeNoteMode(record.noteMode || state.noteMode);
  elements.noteModeSelect.value = state.noteMode;
  localStorage.setItem(NOTE_MODE_STORAGE, state.noteMode);

  if (record.audioUrl) {
    clearCurrentAudioObjectUrl();
    elements.audioPlayer.src = `${record.audioUrl}?v=${encodeURIComponent(record.updatedAt || record.createdAt)}`;
    elements.audioPlayer.hidden = false;
  } else if (state.mode === "standalone" && record.hasAudio) {
    const audioBlob = await getLocalAudio(record.id);

    if (audioBlob) {
      clearCurrentAudioObjectUrl();
      state.currentAudioObjectUrl = URL.createObjectURL(audioBlob);
      elements.audioPlayer.src = state.currentAudioObjectUrl;
      elements.audioPlayer.hidden = false;
    } else {
      elements.audioPlayer.hidden = true;
      elements.audioPlayer.removeAttribute("src");
    }
  } else {
    clearCurrentAudioObjectUrl();
    elements.audioPlayer.hidden = true;
    elements.audioPlayer.removeAttribute("src");
  }

  renderRecordList();
  updateControls();
}

function selectedMeta(record) {
  const pieces = [formatDate(record.createdAt)];

  if (record.transcriptSource) {
    pieces.push(`文字起こし: ${sourceLabel(record.transcriptSource)}`);
  }

  if (record.noteSource) {
    pieces.push(`ノート: ${sourceLabel(record.noteSource)}`);
  }

  pieces.push(`形式: ${noteModeLabel(record.noteMode)}`);
  pieces.push(record.hasAudio ? `音声期限: ${formatDate(record.expiresAt)}` : "音声削除済み");

  return pieces.join(" / ");
}

function upsertRecord(record) {
  const index = state.records.findIndex((item) => item.id === record.id);

  if (index === -1) {
    state.records.unshift(record);
  } else {
    state.records[index] = record;
  }

  renderRecordList();
}

function selectedRecord() {
  return state.records.find((item) => item.id === state.selectedId) || null;
}

function clearSelectedRecord() {
  state.selectedId = null;
  elements.selectedTitle.textContent = "新規録音";
  elements.selectedMeta.textContent = "音声・文字起こし・ノート";
  elements.titleInput.value = "";
  elements.transcriptArea.value = "";
  elements.noteArea.value = "";
  clearCurrentAudioObjectUrl();
  elements.audioPlayer.hidden = true;
  elements.audioPlayer.removeAttribute("src");
  updateControls();
}

function currentTranscript() {
  return [state.finalTranscript, state.interimTranscript].filter(Boolean).join(" ").trim();
}

function updateControls() {
  elements.startButton.disabled = state.recording || state.busy;
  elements.stopButton.disabled = !state.recording;
  elements.audioFileInput.disabled = state.recording || state.busy;
  elements.saveNoteButton.disabled = state.recording || state.busy || !state.selectedId;
  elements.copyNoteButton.disabled = !elements.noteArea.value.trim();
  elements.exportPdfButton.disabled =
    state.busy || (!elements.noteArea.value.trim() && !elements.transcriptArea.value.trim());
  elements.exportFilesButton.hidden = !state.exportEnabled;
  elements.exportFilesButton.disabled = state.recording || state.busy || !state.selectedId;
  elements.historyButton.disabled = !state.historyEnabled;
  elements.historyButton.title = state.historyEnabled ? "" : "Web版では履歴を開けません";
  elements.apiSettingsStatus.textContent = apiSettingsMessage();
  elements.recordDot.classList.toggle("is-recording", state.recording);

  if (!state.recording && !state.timerId) {
    elements.recordTimer.textContent = "00:00";
  }
}

function setBusy(value) {
  state.busy = value;
  updateControls();
}

function setStatus(message) {
  elements.appStatus.textContent = message;
}

function stopStream() {
  if (state.stream) {
    for (const track of state.stream.getTracks()) {
      track.stop();
    }
  }

  state.stream = null;
}

function canUseDirectRecording() {
  return hasAndroidBridge() || window.isSecureContext || isLocalHost(window.location.hostname);
}

function microphoneErrorMessage(error) {
  const name = error?.name || "";

  if (name === "NotAllowedError" || name === "SecurityError") {
    return "マイクが許可されていません。アプリ画面のマイク許可をオンにして、もう一度録音してください。";
  }

  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "使えるマイクが見つかりません。Windowsのマイク設定を確認してください。";
  }

  if (name === "NotReadableError" || name === "TrackStartError") {
    return "マイクを他のアプリが使用中です。通話アプリなどを閉じてから試してください。";
  }

  return error?.message || "マイクを開始できませんでした。";
}

function isLocalHost(hostname) {
  return ["localhost", "127.0.0.1", "::1"].includes(hostname);
}

function titleFromFile(name) {
  const cleanName = String(name || "")
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .trim();

  return cleanName || "スマホ録音";
}

function preferredAudioMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus"
  ];

  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) || "";
}

function shouldUseStandaloneMode() {
  return window.location.protocol === "file:" || hasAndroidBridge();
}

function hasAndroidBridge() {
  return Boolean(window.AndroidNotes);
}

async function initLocalStore() {
  if (state.db) {
    return state.db;
  }

  state.db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);

    request.addEventListener("upgradeneeded", () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(RECORD_STORE)) {
        const records = db.createObjectStore(RECORD_STORE, { keyPath: "id" });
        records.createIndex("createdAt", "createdAt");
      }

      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        db.createObjectStore(AUDIO_STORE, { keyPath: "id" });
      }
    });

    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });

  return state.db;
}

async function createLocalRecording(audioBlob, title) {
  const db = await initLocalStore();
  const now = new Date();
  const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  const record = {
    id,
    title: title || defaultTitle(now),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + RETENTION_MS).toISOString(),
    audioMime: audioBlob.type || "audio/webm",
    audioBytes: audioBlob.size,
    transcript: "",
    note: "",
    status: "uploaded",
    transcriptSource: null,
    noteSource: null,
    noteMode: state.noteMode,
    processingMessage: "",
    hasAudio: true,
    audioUrl: null,
    localAudio: true
  };

  await writeStore(db, AUDIO_STORE, { id, blob: audioBlob });
  await writeStore(db, RECORD_STORE, record);
  return record;
}

async function processLocalRecording(id, browserTranscript) {
  const db = await initLocalStore();
  const record = await readStore(db, RECORD_STORE, id);

  if (!record) {
    throw new Error("録音が見つかりません。");
  }

  record.status = "processing";
  record.processingMessage = "";
  record.noteMode = normalizeNoteMode(record.noteMode || state.noteMode);
  await writeStore(db, RECORD_STORE, record);

  let transcript = (browserTranscript || record.transcript || "").trim();
  let note = "";
  let transcriptSource = transcript ? "browser" : null;
  let noteSource = "local";
  const warnings = [];

  if (hasAndroidBridge() && record.hasAudio) {
    try {
      const audioBlob = await getLocalAudio(id);
      const processed = await processWithAndroidBridge(record, audioBlob);
      transcript = (processed.transcript || transcript).trim();
      note = (processed.note || "").trim();
      transcriptSource = processed.transcript ? "openai" : transcriptSource;
      noteSource = processed.note ? "openai" : noteSource;
    } catch (error) {
      warnings.push(`AI処理: ${error.message}`);
    }
  }

  if (!transcript) {
    record.status = "needs_transcript";
    record.processingMessage =
      "文字起こしが空です。APKではAPIキー設定後にAI文字起こしを使えます。";
    await writeStore(db, RECORD_STORE, record);
    return record;
  }

  if (!note) {
    note = makeStudyNote(
      transcript,
      warnings[0] || "端末内の簡易ノートを作成しました。",
      record.noteMode
    );
  }

  record.transcript = transcript;
  record.note = note;
  record.status = "ready";
  record.processedAt = new Date().toISOString();
  record.transcriptSource = transcriptSource;
  record.noteSource = noteSource;
  record.noteMode = normalizeNoteMode(record.noteMode || state.noteMode);
  record.processingMessage = warnings.join(" / ");

  await writeStore(db, RECORD_STORE, record);
  return record;
}

async function updateLocalRecording(id, changes) {
  const db = await initLocalStore();
  const record = await readStore(db, RECORD_STORE, id);

  if (!record) {
    throw new Error("録音が見つかりません。");
  }

  record.title = cleanTitle(changes.title) || record.title;
  record.transcript = cleanText(changes.transcript);
  record.note = cleanText(changes.note);
  record.noteMode = normalizeNoteMode(changes.noteMode || record.noteMode);
  record.updatedAt = new Date().toISOString();
  await writeStore(db, RECORD_STORE, record);
  return record;
}

async function deleteLocalRecording(id) {
  const db = await initLocalStore();
  await deleteStore(db, AUDIO_STORE, id);
  await deleteStore(db, RECORD_STORE, id);
}

async function getLocalRecords() {
  const db = await initLocalStore();
  const records = await readAllStore(db, RECORD_STORE);

  return records.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function getLocalAudio(id) {
  const db = await initLocalStore();
  const item = await readStore(db, AUDIO_STORE, id);
  return item?.blob || null;
}

async function cleanupLocalExpiredAudio() {
  const db = await initLocalStore();
  const records = await readAllStore(db, RECORD_STORE);
  const now = Date.now();

  for (const record of records) {
    if (!record.hasAudio) {
      continue;
    }

    const expiresAt = new Date(record.expiresAt || record.createdAt).getTime();

    if (Number.isFinite(expiresAt) && now < expiresAt) {
      continue;
    }

    await deleteStore(db, AUDIO_STORE, record.id);
    record.hasAudio = false;
    record.audioBytes = 0;
    record.audioDeletedAt = new Date().toISOString();
    await writeStore(db, RECORD_STORE, record);
  }
}

function readStore(db, storeName, key) {
  return storeRequest(db, storeName, "readonly", (store) => store.get(key));
}

function readAllStore(db, storeName) {
  return storeRequest(db, storeName, "readonly", (store) => store.getAll());
}

function writeStore(db, storeName, value) {
  return storeRequest(db, storeName, "readwrite", (store) => store.put(value));
}

function deleteStore(db, storeName, key) {
  return storeRequest(db, storeName, "readwrite", (store) => store.delete(key));
}

function storeRequest(db, storeName, mode, action) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));

    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

async function processWithAndroidBridge(record, audioBlob) {
  if (!audioBlob) {
    throw new Error("音声ファイルがありません。");
  }

  if (!window.AndroidNotes.hasApiKey?.()) {
    const apiKey = window.prompt("OpenAI APIキーを入力してください。端末内に保存されます。", "");

    if (!apiKey) {
      throw new Error("APIキーが未設定です。");
    }

    window.AndroidNotes.setApiKey(apiKey);
  }

  const requestId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  const base64Audio = await blobToBase64(audioBlob);

  return new Promise((resolve, reject) => {
    state.androidRequests.set(requestId, { resolve, reject });
    window.AndroidNotes.processAudio(
      requestId,
      `${record.id}.${extensionForMime(record.audioMime || audioBlob.type)}`,
      record.audioMime || audioBlob.type || "audio/webm",
      base64Audio
    );
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",").pop() : result);
    });
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(blob);
  });
}

function makeStudyNote(transcript, reason, noteMode = "detailed") {
  const normalized = transcript.replace(/\s+/g, " ").trim();
  const sentences = normalized
    .split(/(?<=[。.!?！？])\s*/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const points = sentences.slice(0, 6);
  const keywords = extractKeywords(normalized);

  if (normalizeNoteMode(noteMode) === "simple") {
    return [
      "# 講義ノート",
      "",
      "## 要点",
      "",
      ...(points.length ? points.slice(0, 5).map((item) => `* ${item}`) : ["* 文字起こしを確認してください。"]),
      "",
      "## 重要語句",
      "",
      ...(keywords.length ? keywords.slice(0, 6).map((item) => `* **${item}**`) : ["* なし"]),
      "",
      "## まとめ",
      "",
      "* 主要な内容を短く整理しました。",
      `* ${reason}`
    ].join("\n");
  }

  return [
    "# 講義ノート",
    "",
    "***",
    "",
    "## 1. 要点",
    "",
    ...(points.length ? points.map((item) => `* ${item}`) : ["* 文字起こしを確認してください。"]),
    "",
    "***",
    "",
    "## 2. 重要語句",
    "",
    ...(keywords.length ? keywords.map((item) => `* **${item}**`) : ["* なし"]),
    "",
    "***",
    "",
    "## 3. 内容整理",
    "",
    "### 背景",
    "",
    "* 授業・録音内で説明された前提を文字起こしから整理してください。",
    "",
    "### 流れ",
    "",
    ...(points.length ? points.slice(0, 4).map((item) => `* ${item}`) : ["* なし"]),
    "",
    "### 結果・意義",
    "",
    "* 重要な結論や意味づけを、必要に応じて追記してください。",
    "",
    "***",
    "",
    "## 4. 全体まとめ",
    "",
    "* 重要な内容を見出しごとに復習しやすい形へ整理しました。",
    `* ${reason}`
  ].join("\n");
}

function extractKeywords(text) {
  const matches = text.match(/[一-龥々ァ-ヶーA-Za-z0-9]{3,}/g) || [];
  const unique = [];

  for (const item of matches) {
    if (!unique.includes(item)) {
      unique.push(item);
    }
  }

  return unique.slice(0, 8);
}

function clearCurrentAudioObjectUrl() {
  if (state.currentAudioObjectUrl) {
    URL.revokeObjectURL(state.currentAudioObjectUrl);
    state.currentAudioObjectUrl = "";
  }
}

function cleanTitle(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function cleanText(value) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, 200000);
}

function safeFileName(value) {
  return String(value || "録音ノート")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^[._\s]+|[._\s]+$/g, "")
    .slice(0, 80) || "録音ノート";
}

function normalizeNoteMode(value) {
  return value === "simple" ? "simple" : "detailed";
}

function noteModeLabel(value) {
  return normalizeNoteMode(value) === "simple" ? "簡易" : "詳細";
}

function defaultTitle(date) {
  return `録音 ${formatHistoryDate(date.toISOString())}`;
}

function extensionForMime(mime) {
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) {
    return "m4a";
  }

  if (mime.includes("mpeg") || mime.includes("mp3")) {
    return "mp3";
  }

  if (mime.includes("wav")) {
    return "wav";
  }

  if (mime.includes("ogg")) {
    return "ogg";
  }

  return "webm";
}

function printableNoteHtml(title, createdAt, transcript, note) {
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        color: #182026;
        font-family: "Yu Gothic", "Yu Gothic UI", Meiryo, sans-serif;
        line-height: 1.75;
        margin: 32px;
      }
      h1 {
        font-size: 24px;
        margin: 0 0 6px;
      }
      .meta {
        color: #64717d;
        font-size: 12px;
        margin-bottom: 24px;
      }
      h2 {
        border-bottom: 1px solid #d7dee5;
        font-size: 16px;
        margin: 24px 0 10px;
        padding-bottom: 6px;
      }
      pre {
        font: inherit;
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
      }
      @media print {
        body {
          margin: 18mm;
        }
      }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">${escapeHtml(createdAt)}</div>
    <h2>AIノート</h2>
    <pre>${escapeHtml(note || "ノートはまだありません。")}</pre>
    <h2>文字起こし</h2>
    <pre>${escapeHtml(transcript || "文字起こしはまだありません。")}</pre>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const text = await response.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    const error = new Error(data.error || data.processingMessage || "処理に失敗しました。");
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

function statusLabel(status) {
  const labels = {
    uploaded: "保存済み",
    processing: "処理中",
    ready: "ノート作成済み",
    needs_transcript: "文字起こし待ち"
  };

  return labels[status] || "保存済み";
}

function sourceLabel(source) {
  const labels = {
    openai: "AI",
    browser: "ブラウザ",
    local: "ローカル"
  };

  return labels[source] || source;
}

function formatDate(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatHistoryDate(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return `${date.getMonth() + 1}月${date.getDate()}日 ${date.getHours()}時${String(
    date.getMinutes()
  ).padStart(2, "0")}分`;
}
