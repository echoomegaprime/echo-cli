// Reuse the installed Personality Forge transport and its audio allowlist.
import {pathToFileURL} from 'node:url';
import path from 'node:path';
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 1000000) throw new Error('voice_request_too_large');
}
try {
  const request = JSON.parse(input);
  const {VoiceGateway, gatewayConfig, inspectWav} = await import(pathToFileURL(path.join(request.plugin_root, 'mcp-server/dist/gateway.js')));
  const gateway = new VoiceGateway(gatewayConfig({ECHO_VOICE_GATEWAY_BASE: request.gateway_base,
    ECHO_VOICE_GATEWAY_TRANSPORT: 'http', ECHO_AUDIO_ALLOWED_HOSTS: new URL(request.gateway_base).host}));
  let result;
  if (request.operation === 'prepare') {
    const {prepareSpeech} = await import(pathToFileURL(path.join(request.plugin_root, 'mcp-server/dist/speech.js')));
    result = prepareSpeech(request.text, request.mode || 'full', 420);
  } else if (request.operation === 'speak') {
    if (!['eleven_v4', 'eleven_v4_turbo'].includes(request.model)) throw new Error('unsupported_speech_model');
    const body = await gateway.request('speak', {text: request.text, persona: request.persona, provider: 'elevenlabs', format: 'wav',
      model: request.model, provider_opts: {allow_fallback: false, voice_settings: {stability: 0.5, similarity_boost: 0.75, style: 0.6, use_speaker_boost: true}}});
    if (body.provider !== 'elevenlabs' || body.format !== 'wav') throw new Error('speech_provider_or_format_mismatch');
    const ref = /^[a-f0-9]{32}\.wav$/.test(body.local_artifact_id || '') ? '/public/audio/' + body.local_artifact_id : body.url;
    result = {provider: 'elevenlabs', format: 'wav', url: gateway.audioUrl(ref), requested_model: request.model};
  } else if (request.operation === 'transcribe') {
    const audio = Buffer.from(request.audio_b64, 'base64');
    const info = inspectWav(audio);
    if (audio.length > 262144 || info.sample_rate !== 16000 || info.channels !== 1) throw new Error('invalid_microphone_audio');
    result = await gateway.request('transcribe', {audio_b64: request.audio_b64, provider: 'elevenlabs-scribe'});
    if (result.provider !== 'elevenlabs-scribe' || typeof result.text !== 'string') throw new Error('stt_provider_or_response_mismatch');
    result = {provider: result.provider, text: result.text};
  } else if (request.operation === 'audio') {
    const audio = await gateway.audio(request.url);
    if (audio.length > 16000000) throw new Error('speech_audio_too_large');
    const info = inspectWav(audio);
    result = {...info, audio_b64: audio.toString('base64')};
  } else throw new Error('voice_operation_not_allowed');
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  const reason = String(error.message || 'voice_transport_failed');
  process.stderr.write(JSON.stringify({error: /^[a-z0-9_]+$/.test(reason) ? reason : 'voice_transport_failed'}));
  process.exitCode = 1;
}
