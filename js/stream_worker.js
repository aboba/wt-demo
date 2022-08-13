'use strict';

let encoder, decoder, pl, started = false, stopped = false;
let enc_aggregate = {
  all: [],
  min: Number.MAX_VALUE,
  max: 0,
  avg: 0,
  sum: 0,
};

let dec_aggregate = {
  all: [],
  min: Number.MAX_VALUE,
  max: 0,
  avg: 0,
  sum: 0,
};

let encqueue_aggregate = {
  all: [],
  min: Number.MAX_VALUE,
  max: 0,
  avg: 0,
  sum: 0,
};

let decqueue_aggregate = {
  all: [],
  min: Number.MAX_VALUE,
  max: 0,
  avg: 0,
  sum: 0,
};

function enc_update(duration) {
  enc_aggregate.all.push(duration);
  enc_aggregate.min = Math.min(enc_aggregate.min, duration);
  enc_aggregate.max = Math.max(enc_aggregate.max, duration);
  enc_aggregate.sum += duration;
}

function encqueue_update(duration) {
  encqueue_aggregate.all.push(duration);
  encqueue_aggregate.min = Math.min(encqueue_aggregate.min, duration);
  encqueue_aggregate.max = Math.max(encqueue_aggregate.max, duration);
  encqueue_aggregate.sum += duration;
}

function enc_report() {
  enc_aggregate.all.sort();
  const len = enc_aggregate.all.length;
  const half = len >> 1;
  const median = len % 2 === 1 ? enc_aggregate.all[len >> 1] : (enc_aggregate.all[half - 1] + enc_aggregate.all[half]) / 2;
  return {
     count: len,
     min: enc_aggregate.min,
     max: enc_aggregate.max,
     avg: enc_aggregate.sum / len,
     median,
  };
}

function encqueue_report() {
  encqueue_aggregate.all.sort();
  const len = encqueue_aggregate.all.length;
  const half = len >> 1;
  const median = len % 2 === 1 ? encqueue_aggregate.all[len >> 1] : (encqueue_aggregate.all[half - 1] + encqueue_aggregate.all[half]) / 2;
  return {
     count: len,
     min: encqueue_aggregate.min,
     max: encqueue_aggregate.max,
     avg: encqueue_aggregate.sum / len,
     median,
  };
}

function dec_update(duration) {
   dec_aggregate.all.push(duration);
   dec_aggregate.min = Math.min(dec_aggregate.min, duration);
   dec_aggregate.max = Math.max(dec_aggregate.max, duration);
   dec_aggregate.sum += duration;
}

function dec_report() {
  dec_aggregate.all.sort();
  const len  = dec_aggregate.all.length;
  const half = len >> 1;
  const median = len % 2 === 1 ? dec_aggregate.all[len >> 1] : (dec_aggregate.all[half - 1] + dec_aggregate.all[half]) / 2;
  return {
     count: len,
     min: dec_aggregate.min,
     max: dec_aggregate.max,
     avg: dec_aggregate.sum / len,
     median,
  };
}

function decqueue_update(duration) {
   decqueue_aggregate.all.push(duration);
   decqueue_aggregate.min = Math.min(decqueue_aggregate.min, duration);
   decqueue_aggregate.max = Math.max(decqueue_aggregate.max, duration);
   decqueue_aggregate.sum += duration;
}

function decqueue_report() {
  decqueue_aggregate.all.sort();
  const len  = decqueue_aggregate.all.length;
  const half = len >> 1;
  const median = len % 2 === 1 ? decqueue_aggregate.all[len >> 1] : (decqueue_aggregate.all[half - 1] + decqueue_aggregate.all[half]) / 2;
  return {
     count: len,
     min: decqueue_aggregate.min,
     max: decqueue_aggregate.max,
     avg: decqueue_aggregate.sum / len,
     median,
  };
}

self.addEventListener('message', async function(e) {
  if (stopped) return;
  // In this demo, we expect at most two messages, one of each type.
  let type = e.data.type;
  let transport;

  if (type == "stop") {
    self.postMessage({text: 'Stop message received.'});
    if (started) pl.stop();
    return;
  } else if (type != "stream"){
    self.postMessage({severity: 'fatal', text: 'Invalid message received.'});
    return;
  }
  // We received a "stream" event
  self.postMessage({text: 'Stream event received.'});

  // Create WebTransport
  try {
    transport = new WebTransport(e.data.url);
    self.postMessage({text: 'Initiating connection...'});
  } catch (e) {
    self.postMessage({severity: 'fatal', text: `Failed to create connection object: ${e.message}`});
    return;
  }

  try {
    await transport.ready;
    self.postMessage({text: 'Connection ready.'});
    pl = new pipeline(e.data, transport);
    pl.start();
  } catch (e) {
    self.postMessage({severity: 'fatal', text: `Connection failed: ${e.message}`});
    return;
  }

  try {
    await transport.closed;
    self.postMessage({text: 'Connection closed normally.'});
  } catch (e) {
    self.postMessage({severity: 'fatal', text: `Connection closed abruptly: ${e.message}`});
    pl.stop();
    return;
  }

}, false);

class pipeline {

   constructor(eventData, transport) {
     this.stopped = false;
     this.transport = transport;
     this.inputStream = eventData.streams.input;
     this.outputStream = eventData.streams.output;
     this.config = eventData.config;
   }

/*
Header format:
                     1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|1 1 0 0 0 0 0 0|       PT      |S|E|I|D|B| TID |    LID        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      sequence number                          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      keyframe index                           |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      deltaframe index                         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      timestamp...
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      timestamp                                |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                         SSRC                                  |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      Payload...
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

PT = payload type:
  x00 = Decoder Configuration
  x01 = H.264
  x02 = H.265
  x03 = VP8
  x04 = VP9
  x05 = AV1
S, E, I, D, B, TID, LID defined in draft-ietf-avtext-framemarking
   I = 1 means chunk.type == 'key', 0 means chunk.type == 'delta'
   TID = chunk.temporalLayerId
   LID = 0 (no support for spatial scalability)
sequence number = counter incrementing with each frame
keyframe index = how many keyframes have been sent
deltaframe index = how many delta frames since the last keyframe
timestamp = chunk.timestamp
SSRC = this.config.ssrc
*/

   Serialize(self, config) {
     return new TransformStream({
       start (controller) {
       },
       transform(chunk, controller) {
         const writeUInt32 = function(arr, pos, val)
         {
           let view = new DataView(arr);
           view.setUint32(pos, val, false);
         };
         const writeUInt64 = function(arr, pos, val)
         {
           let view = new DataView(arr);
           view.setBigUint64(pos, val, false);
         };
         if (chunk.type == 'config') {
           chunk.temporalLayerId = 0;
           chunk.duration = 0;
           chunk.timestamp = 0;
         }  
         //Serialize the chunk
         let hdr = new ArrayBuffer( 4 + 4 + 4 + 4 + 8 + 4);
         let tid = chunk.temporalLayerId;
         let i = (chunk.type == 'key' ? 1 : 0);
         let d = (chunk.temporalLayerId == 0 ? 0 : 1);
         let b = (chunk.temporalLayerId == 0 ? 1 : 0);
         let B0 = 0;
         let B1 = 3 | (i << 2) | (d << 3) | (b << 4) | (tid << 5);
         let pt = (chunk.type == "config" ? 0 : config.pt);
         let B2 = pt;
         let B3 = 3;
         let first4 = B0 | (B1 << 8) | (B2 << 16) | (B3 << 24);
         writeUInt32(hdr, 0, first4);
         writeUInt32(hdr, 4, chunk.seqNo);
         writeUInt32(hdr, 8, chunk.keyframeIndex);
         writeUInt32(hdr, 12, chunk.deltaframeIndex);
         writeUInt64(hdr, 16, BigInt(chunk.timestamp));
         writeUInt32(hdr, 24, config.ssrc);
         // self.postMessage({text: 'Serial B0: ' + B0 + ' B1: ' + B1 + ' B2: ' + B2 + ' B3: ' + B3});
         // self.postMessage({text: 'Serial seq: ' + chunk.seqNo + ' kf: ' + chunk.keyframeIndex + ' delta: ' + chunk.deltaframeIndex + ' dur: ' + chunk.duration + ' ts: ' + chunk.timestamp + ' ssrc: ' + config.ssrc +  ' pt: ' + pt + ' tid: ' + tid + ' type: ' + chunk.type + ' discard: ' + d + ' base: ' + b});
         if (chunk.type == "config") {
           let enc = new TextEncoder();
           const cfg = enc.encode(chunk.config); 
           // self.postMessage({text: 'Serial Config: ' + chunk.config + ' Length: ' + cfg.length});
           let result = new Uint8Array( hdr.byteLength + cfg.length);
           result.set(new Uint8Array(hdr), 0);
           result.set(new Uint8Array(cfg), hdr.byteLength);
           controller.enqueue(result.buffer); 
         } else {
           let result = new Uint8Array( hdr.byteLength + chunk.byteLength);
           result.set(new Uint8Array(hdr), 0);
           let data = new ArrayBuffer(chunk.byteLength);
           chunk.copyTo(data);
           result.set(new Uint8Array(data), hdr.byteLength);
           // self.postMessage({text: 'Serial hdr: ' + hdr.byteLength + ' chunk length: ' + chunk.byteLength + ' result length: ' + result.byteLength});
           controller.enqueue(result.buffer);
         }
      }
     });
   }

   Deserialize(self) {
     return new TransformStream({
       start (controller) {
       },
       transform(chunk, controller) {
         const readUInt32 = function(arr, pos)
         {
           let view = new DataView(arr);
           return view.getUint32(pos, false);
         };
         const readUInt64 = function(arr, pos)
         {
           let view = new DataView(arr);
           return Number(view.getBigUint64(pos, false));
         };
         const first4 = readUInt32(chunk, 0);
         const B0 =  first4 & 0x000000FF;
         const B1 = (first4 & 0x0000FF00) >> 8;
         const B2 = (first4 & 0x00FF0000) >> 16;
         const B3 = (first4 & 0xFF000000) >> 24; 
         // self.postMessage({text: 'Deserial B0: ' + B0 + ' B1: ' + B1 + ' B2: ' + B2 + ' B3: ' + B3});
         const lid = B0;
         const pt =  B2;
         const tid = (B1 & 0xE0) >> 5;
         const i = (B1 & 0x04) >> 2;
         const seqNo = readUInt32(chunk, 4)
         const keyframeIndex   = readUInt32(chunk, 8);
         const deltaframeIndex = readUInt32(chunk, 12);
         const timestamp = readUInt64(chunk, 16);
         const ssrc = readUInt32(chunk, 24);
         let hydChunk;
         if (pt == 0) {
           hydChunk = {
             type: "config",
             timestamp: timestamp,
           };
           let dec = new TextDecoder();
           hydChunk.config = dec.decode(new Uint8Array(chunk, 28));
           // self.postMessage({text: 'Deserial Config: ' + hydChunk.config});
         } else {
           let data = new Uint8Array(chunk.byteLength - 28); //create Uint8Array for data
           data.set(new Uint8Array(chunk, 28));
           hydChunk = new EncodedVideoChunk ({
              type: (i == 1 ? 'key' : 'delta'),
              timestamp: timestamp,
              data: data.buffer
           });
         }
         hydChunk.temporalLayerId = tid;
         hydChunk.ssrc = ssrc;
         hydChunk.pt = pt;
         hydChunk.seqNo = seqNo;
         hydChunk.keyframeIndex = keyframeIndex;
         hydChunk.deltaframeIndex = deltaframeIndex;
         // self.postMessage({text: 'Deserial hdr: 28 ' + 'chunk length: ' + chunk.byteLength });
         // self.postMessage({text: 'Deserial seq: ' + hydChunk.seqNo + ' kf: ' + hydChunk.keyframeIndex + ' delta: ' + hydChunk.deltaframeIndex + ' dur: ' + hydChunk.duration + ' ts: ' + hydChunk.timestamp + ' ssrc: ' + hydChunk.ssrc + ' pt: ' + hydChunk.pt + ' tid: ' + tid + ' type: ' + hydChunk.type});
         controller.enqueue(hydChunk);
       }
     });
   }

   DecodeVideoStream(self) {
     return new TransformStream({
       start(controller) {
         this.decoder = decoder = new VideoDecoder({
           output: frame => controller.enqueue(frame),
           error: (e) => {
              self.postMessage({severity: 'fatal', text: `Init Decoder error: ${e.message}`});
           }
         });
       },
       transform(chunk, controller) {
         if (this.decoder.state != "closed") {
           if (chunk.type == "config") {
              let config = JSON.parse(chunk.config);
              VideoDecoder.isConfigSupported(config).then((decoderSupport) => {
                if(decoderSupport.supported) {
                  this.decoder.configure(decoderSupport.config);
                  self.postMessage({text: 'Decoder successfully configured:\n' + JSON.stringify(decoderSupport.config)});
                 // self.postMessage({text: 'Decoder state: ' + JSON.stringify(this.decoder.state)});
                } else {
                self.postMessage({severity: 'fatal', text: 'Config not supported:\n' + JSON.stringify(decoderSupport.config)});
                }
              })
              .catch((e) => {
                 self.postMessage({severity: 'fatal', text: 'Configuration error: ' + e.message});
              })
           } else {
             try {
              // self.postMessage({text: 'size: ' + chunk.byteLength + ' seq: ' + chunk.seqNo + ' kf: ' + chunk.keyframeIndex + ' delta: ' + chunk.deltaframeIndex + ' dur: ' + chunk.duration + ' ts: ' + chunk.timestamp + ' ssrc: ' + chunk.ssrc + ' pt: ' + chunk.pt + ' tid: ' + chunk.temporalLayerId + ' type: ' + chunk.type});
               const queue = this.decoder.decodeQueueSize;
               decqueue_update(queue);
               const before = performance.now();
               this.decoder.decode(chunk);
               const after = performance.now();
               const duration = after - before;
               dec_update(duration);
             } catch (e) {
               self.postMessage({severity: 'fatal', text: 'Derror size: ' + chunk.byteLength + ' seq: ' + chunk.seqNo + ' kf: ' + chunk.keyframeIndex + ' delta: ' + chunk.deltaframeIndex + ' dur: ' + chunk.duration + ' ts: ' + chunk.timestamp + ' ssrc: ' + chunk.ssrc + ' pt: ' + chunk.pt + ' tid: ' + chunk.temporalLayerId + ' type: ' + chunk.type});
               self.postMessage({severity: 'fatal', text: `Catch Decode error: ${e.message}`});
             }
           }
         }
       }
     });
   }

   EncodeVideoStream(self, config) {
     return new TransformStream({
       start(controller) {
         this.frameCounter = 0;
         this.seqNo = 0;
         this.keyframeIndex = 0;
         this.deltaframeIndex = 0;
         this.pending_outputs = 0;
         this.encoder = encoder = new VideoEncoder({
           output: (chunk, cfg) => {
             if (cfg.decoderConfig) {
               // self.postMessage({text: 'Decoder reconfig!'});
               const decoderConfig = JSON.stringify(cfg.decoderConfig);
               // self.postMessage({text: 'Configuration: ' + decoderConfig});
               const configChunk =
               {
                  type: "config",
                  seqNo: this.seqNo,
                  keyframeIndex: this.keyframeIndex,
                  deltaframeIndex: this.deltaframeIndex,
                  timestamp: 0,
                  pt: 0,
                  config: decoderConfig 
               };
               controller.enqueue(configChunk); 
             } 
             chunk.temporalLayerId = 0;
             if (cfg.temporalLayerId) {
               chunk.temporalLayerId = cfg.temporalLayerId;
             }
             this.seqNo++;
             if (chunk.type == 'key') {
               this.keyframeIndex++;
               this.deltaframeIndex = 0;
             } else {
               this.deltaframeIndex++;
             } 
             this.pending_outputs--;
             chunk.seqNo = this.seqNo;
             chunk.keyframeIndex = this.keyframeIndex;
             chunk.deltaframeIndex = this.deltaframeIndex;
             controller.enqueue(chunk);
           },
           error: (e) => {
             self.postMessage({severity: 'fatal', text: `Encoder error: ${e.message}`});
           }
         });
         VideoEncoder.isConfigSupported(config).then((encoderSupport) => {
           if(encoderSupport.supported) {
             this.encoder.configure(encoderSupport.config);
             self.postMessage({text: 'Encoder successfully configured:\n' + JSON.stringify(encoderSupport.config)});
             // self.postMessage({text: 'Encoder state: ' + JSON.stringify(this.encoder.state)});
           } else {
             self.postMessage({severity: 'fatal', text: 'Config not supported:\n' + JSON.stringify(encoderSupport.config)});
           }
         })
         .catch((e) => {
            self.postMessage({severity: 'fatal', text: `Configuration error: ${e.message}`});
         })
       },
       transform(frame, controller) {
         if (this.pending_outputs <= 30) {
           this.pending_outputs++;
           const insert_keyframe = (this.frameCounter % config.keyInterval) == 0;
           this.frameCounter++;
           try {
             if (this.encoder.state != "closed") {
               if (this.frameCounter % 20 == 0) {
                 // self.postMessage({text: 'Encoded 20 frames'});
               }
               const queue = this.encoder.encodeQueueSize;
               encqueue_update(queue);
               const before = performance.now();
               this.encoder.encode(frame, { keyFrame: insert_keyframe });
               const after = performance.now();
               const duration = after - before;
               enc_update(duration);
             } 
           } catch(e) {
             self.postMessage({severity: 'fatal', text: `Encoder Error: ${e.message}`});
           }
         }
         frame.close();
       }
     });
   }

   stop() {
     const enc_stats = enc_report();
     const encqueue_stats = encqueue_report();
     const dec_stats = dec_report();
     const decqueue_stats = decqueue_report();
     self.postMessage({severity: 'info', text: 'Encoder Time report: ' + JSON.stringify(enc_stats)});
     self.postMessage({severity: 'info', text: 'Encoder Queue report: ' + JSON.stringify(encqueue_stats)});
     self.postMessage({security: 'info', text: 'Decoder Time report: ' + JSON.stringify(dec_stats)});
     self.postMessage({severity: 'info', text: 'Decoder Queue report: ' + JSON.stringify(decqueue_stats)});
     if (stopped) return;
     stopped = true;
     this.stopped = true;
     self.postMessage({severity: 'fatal', text: 'stop() called'});
     // TODO: There might be a more elegant way of closing a stream, or other
     // events to listen for.
     if (encoder.state != "closed") encoder.close();
     if (decoder.state != "closed") decoder.close();
     self.postMessage({severity: 'fatal', text: "stop(): frame, encoder and decoder closed"});
     return;
   }

   SendStream(self, transport) {
     return new WritableStream({
       async start(controller) {
         // called by constructor
         // test to see if transport is still usable?
       },
       async write(chunk, controller) {
         let stream = await transport.createUnidirectionalStream();
         let writer = stream.getWriter();
         await writer.write(chunk);
         await writer.close();
       }, 
       async close(controller) {
         // close the transport? 
         await transport.close();
       }, 
       async abort(reason) {
         // called when ws.abort(reason)
         // close the transport?
         await transport.close(); 
       } 
     });
   }

   ReceiveStream(self, transport) {
     return new ReadableStream({
       async start(controller) {
       // called by constructor
         this.streamNumber = 0;
         this.reader = transport.incomingUnidirectionalStreams.getReader();
       },
       async pull(controller) {
         // called read when controller's queue is empty
         let stream_reader, number;
         try {
           const { value, done } = await this.reader.read();
           if (done) {
             self.postMessage({severity: 'fatal', text: 'Done accepting unidirectional streams'});
             return;
           }
           number = this.streamNumber++;
           self.postMessage({text: 'New incoming stream # ' + number});
           stream_reader = value.getReader();
         } catch (e) {
           self.postMessage({severity: 'fatal', text: `Error in obtaining stream.getReader(), stream # ${number} : ${e.message}`});
         }
         try {
           while (true) {
             const { value, done } = await stream_reader.read();
             if (done) {
                return;
             }
             let buf = new ArrayBuffer(value.length);
             let bufView = new Uint8Array(buf);
             for (var i=0, bufLen=value.length; i < bufLen; i++) {
               bufView[i] = value[i];
             }
             self.postMessage({text: 'Chunk arriving: ' + JSON.stringify(buf)});
             controller.enqueue(buf);
           }
         } catch (e) {
           self.postMessage({severity: 'fatal', text: `Error while reading from stream # ${number} : ${e.message}`});
         }
       },
       async cancel(reason){
         // called when cancel(reason) is called
       }
     });
   }

   async start()
   {
     if (stopped) return;
     started = true;
     self.postMessage({text: 'Start method called.'});
     try { 
       this.inputStream
           .pipeThrough(this.EncodeVideoStream(self,this.config))
           .pipeThrough(this.Serialize(self,this.config))
           .pipeTo(this.SendStream(self,this.transport));
     } catch (e) {
       self.postMessage({severity: 'fatal', text: `input pipeline error: ${e.message}`});
     }
     try {
       this.ReceiveStream(self,this.transport)
           .pipeThrough(this.Deserialize(self))
           .pipeThrough(this.DecodeVideoStream(self))
           .pipeTo(this.outputStream);
     } catch (e) {
       self.postMessage({severity: 'fatal', text: `output pipeline error: ${e.message}`});
     }
   }
}
