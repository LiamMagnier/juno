/* global AudioWorkletProcessor, registerProcessor */
class JunoMicTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel?.length) this.port.postMessage(channel.slice());
    return true;
  }
}

registerProcessor("juno-mic-tap", JunoMicTap);
