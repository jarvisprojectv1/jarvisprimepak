// tools/voice/index.ts - re-exports the real `voice` Tool (Phase 9),
// replacing the old Phase 1 tools/voice.ts NOT_IMPLEMENTED stub. tools/index.ts
// imports `voiceTool` from "./voice" (this directory) unchanged.
export { voiceTool, createVoiceTool } from "./voiceTool";
export type { VoiceProvider, SpeechRecognitionProvider, TextToSpeechProvider } from "./types";
