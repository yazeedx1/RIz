const { loadState } = require('./configStore');

const INTERACTIONS_API_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

/**
 * Cleans markdown, URLs, and code blocks from a reply so TTS reads naturally.
 */
function cleanTextForSpeech(rawText) {
  if (!rawText) return '';
  return String(rawText)
    .replace(/```[\s\S]*?```/g, 'Code snippet attached in chat.')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_~#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Splits text into natural sentence chunks <= maxLen characters for fast parallel TTS.
 */
function splitIntoTtsChunks(text, maxLen = 180) {
  const cleaned = cleanTextForSpeech(text);
  if (!cleaned) return [];
  const sentences = cleaned.match(/[^.!?،؛\n]+[.!?،؛\n]*/g) || [cleaned];
  const chunks = [];
  let current = '';

  for (const s of sentences) {
    const trimmed = s.trim();
    if (!trimmed) continue;
    if ((current + ' ' + trimmed).trim().length <= maxLen) {
      current = (current + ' ' + trimmed).trim();
    } else {
      if (current) chunks.push(current);
      if (trimmed.length <= maxLen) {
        current = trimmed;
      } else {
        // Split long sentence by words
        const words = trimmed.split(/\s+/);
        let sub = '';
        for (const w of words) {
          if ((sub + ' ' + w).trim().length <= maxLen) {
            sub = (sub + ' ' + w).trim();
          } else {
            if (sub) chunks.push(sub);
            sub = w.slice(0, maxLen);
          }
        }
        current = sub;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.slice(0, 8); // Cap at 8 chunks (~60 seconds of speech)
}

/**
 * Synthesizes natural spoken MP3 audio from text in <500ms using parallel neural TTS chunks.
 * Automatically detects Arabic vs English script.
 */
async function synthesizeSpeechMp3(text) {
  const chunks = splitIntoTtsChunks(text, 180);
  if (chunks.length === 0) return null;

  const hasArabic = /[\u0600-\u06FF]/.test(text);
  const lang = hasArabic ? 'ar' : 'en';

  try {
    const buffers = await Promise.all(
      chunks.map(async (chunk) => {
        const url =
          `https://translate.googleapis.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${lang}&q=` +
          encodeURIComponent(chunk);
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0'
          }
        });
        if (!res.ok) {
          throw new Error(`TTS HTTP ${res.status}`);
        }
        const arr = await res.arrayBuffer();
        return Buffer.from(arr);
      })
    );
    return Buffer.concat(buffers);
  } catch (err) {
    console.error('[Riz Voice TTS Error]:', err.message);
    return null;
  }
}

/**
 * Transcribes incoming voice notes or microphone audio (OGG/Opus, WebM, MP4, MP3, WAV)
 * using Gemini Multimodal Interactions API with minimal thinking latency.
 */
async function transcribeAudioWithGemini({ audioBuffer, mimeType = 'audio/ogg' }) {
  if (!audioBuffer || !audioBuffer.length) {
    return '';
  }
  const state = loadState();
  const apiKey = (state.config && state.config.geminiApiKey) || process.env.GEMINI_API_KEY || '';
  if (!apiKey) {
    throw new Error('Gemini API key is required for voice transcription.');
  }

  // Normalize mimeType (strip "; codecs=opus" if present)
  const cleanMime = String(mimeType || 'audio/ogg').split(';')[0].trim() || 'audio/ogg';
  const base64Audio = Buffer.from(audioBuffer).toString('base64');

  const candidateModels = ['gemini-flash-lite-latest', 'gemini-3.6-flash', 'gemini-3.5-flash'];
  for (const model of candidateModels) {
    try {
      const res = await fetch(INTERACTIONS_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
          'Api-Revision': '2026-05-20'
        },
        body: JSON.stringify({
          model,
          generation_config: { thinking_level: 'minimal' },
          input: [
            {
              type: 'text',
              text:
                'Transcribe this voice message accurately word-for-word. ' +
                'Note: If the speaker says a name like "Riz", "Reez", "Rizz", or "Ris", transcribe it as "Riz". ' +
                'If the speaker says "Blacky" or "blackie", transcribe it as "blacky". ' +
                'Return ONLY the spoken words with no quotes or extra commentary.'
            },
            {
              type: 'audio',
              data: base64Audio,
              mime_type: cleanMime
            }
          ]
        })
      });

      if (!res.ok) continue;
      const interaction = await res.json();
      let transcript = '';
      if (Array.isArray(interaction.steps)) {
        for (const step of interaction.steps) {
          if (step.type === 'model_output' && Array.isArray(step.content)) {
            for (const block of step.content) {
              if (block.type === 'text' && block.text) {
                transcript += block.text;
              }
            }
          }
        }
      }
      if (!transcript && interaction.output_text) {
        transcript = interaction.output_text;
      }
      if (transcript && transcript.trim()) {
        return transcript.trim();
      }
    } catch (_) {}
  }

  return '';
}

module.exports = {
  cleanTextForSpeech,
  synthesizeSpeechMp3,
  transcribeAudioWithGemini
};
