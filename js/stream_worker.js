'use strict';

let encoder, decoder, pl, started = false, stopped = false, rtt_min = 100., start_time, end_time, seqPointer = 0;
const HEADER_LENGTH = 28;

importScripts('./stats.js');

async function writeChunk(transport, chunk, rto, info) {
  let writable, writer, timeoutId;
  try {
    writable = await transport.createUnidirectionalStream();
    writer = writable.getWriter();
    await writer.ready;
  } catch (e) {
    self.postMessage({text: `Failure to create writable stream ${e.message}`});
    writer.releaseLock();
    writable.close();
    return Promise.reject(e);
  }
  timeoutId = setTimeout(() => {
    writer.abort().then(
      ()  => {
        self.postMessage({text: 'Abort failed.'});
        writer.releaseLock();
        return Promise.resolve();
      }).catch((e) => {
        self.postMessage({text: `Aborted seqno: ${info.seqno} len: ${info.packlen} i: ${info.i} d: ${info.d} b: ${info.b} pt: ${info.pt} tid: ${info.tid} Send RTO: ${rto}`});
        writer.releaseLock();
        return Promise.resolve();       
      });
  }, rto);
  try {
    writer.write(chunk);
  } catch (e) {
    self.postMessage({text: `Chunk cannot be written: ${e.message}`});
    writer.releaseLock();
    return Promise.reject(e);
  }
  writer.close().then(
    () => {
      clearTimeout(timeoutId);
      writer.releaseLock();
      return Promise.resolve();
    }).catch((e) => {
      clearTimeout(timeoutId);
      //self.postMessage({text: 'Stream cannot be closed (due to abort).'});
      writer.releaseLock();
      return Promise.resolve();
    });
}

async function readInto(reader, buffer, offset) {
  let off = offset;
  while (off < buffer.byteLength) {
    const {value: view, done} =
     await reader.read(new Uint8Array(buffer, off, buffer.byteLength - off));
    buffer = view.buffer;
    if (done) {
      break;
    }
    off += view.byteLength;
  }
  return Promise.resolve(buffer);
}

async function get_frame(readable, number) {
  let packlen, totalen = 0, frame, header, sendTime, seqno;
  let hdr = new ArrayBuffer(HEADER_LENGTH);
  let reader = readable.getReader({mode: "byob"}); 
  try {
    header = new Uint8Array(await readInto(reader, hdr, 0));
  } catch (e) {
    reader.releaseLock();
    self.PostMessage({text: `Couldn't read frame header from stream# ${number}: ${e.message}`});
    return Promise.reject(e);
  }
  packlen = (header[0] << 24) | (header[1] << 16) | (header[2] << 8) | (header[3] << 0);
  if ((packlen < 1) || (packlen > 300000)) {
    reader.releaseLock();
    let e = new Error(`Frame length problem: ${packen}`);
    self.postMessage({text: `${e.message}`});  
    return Promise.reject(e);
  }
  // Retrieve sendTime from header
  sendTime = (header[8] << 24) | (header[9] << 16) | (header[10] << 8) | (header[11] << 0);
  seqno = (header[12] << 24) | (header[13] << 16) | (header[14] << 8) | (header[15] << 0);
  frame = new Uint8Array(packlen);
  frame.set(header, 0);
  totalen = HEADER_LENGTH;
  //self.postMessage({text: 'sendTime: ' + sendTime/1000. + ' seqno: ' + seqno + ' len: ' + packlen});
  try {
    frame = await readInto(reader, frame.buffer, totalen);
  } catch (e) {
    reader.releaseLock();
    self.postMessage({text: `readInto failed: ${e.message}`});
    return Promise.reject(e);
  }
  totalen = frame.byteLength;
  if (packlen == totalen) {
    let rtt = ((0xffffffff & Math.trunc(1000 * performance.now())) - sendTime)/1000.; 
    rtt_update(packlen, rtt);
    bwe_update(seqno, packlen, rtt); 
    //self.postMessage({text: 'sendTime: ' + sendTime/1000. + ' seqno: ' + seqno + ' len: ' + packlen + ' rtt: ' + rtt});
    reader.releaseLock();
    return Promise.resolve(frame); //complete frame has been received
  } else {
    let e = new Error(`ReceiveStream: frame #: ${number} Received len: ${totalen} Packet Len: ${packlen} Actual len: ${frame.byteLength}`);
    self.postMessage({text: `${e.message}`});
    return Promise.reject(e);
  }
  reader.releaseLock();
}

function writeUInt32(arr, pos, val) {
  let view = new DataView(arr);
  view.setUint32(pos, val, false); //Big-endian
};

function writeUInt64(arr, pos, val) {
  let view = new DataView(arr);
  view.setBigUint64(pos, val, false); //Big-endian
};

function readUInt32(arr, pos) {
  let view = new DataView(arr);
  return view.getUint32(pos, false); //Big-endian
 };
 
function readUInt64(arr, pos) {
  let view = new DataView(arr);
  return Number(view.getBigUint64(pos, false)); //Big-endian
};

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
Header format (28 octets):
                     1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      length                                   |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|1 1 0 0 0 0 0 0|       PT      |S|E|I|D|B| TID |    LID        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                   send time (performance.now)                 |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      sequence number                          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      timestamp...
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      timestamp                                |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                         SSRC                                  |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                      Payload...
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

length = length of the frame, including the header
PT = payload type:
  x00 = Decoder Configuration
  x01 = H.264
  x02 = H.265
  x03 = VP8
  x04 = VP9
  x05 = AV1
S, E, I, D, B, TID, LID defined in draft-ietf-avtext-framemarking
   S, E always = 1 in frame/stream encoding
   I = 1 for chunk.type == 'key', 0 for chunk.type == 'delta'
   D = Not a keyframe, configuration or base layer frame 
   B = Base layer frame
   TID = chunk.svc.temporalLayerId
   LID = 0 (no support for spatial scalability yet)
send time = time at which the packet was sent, in microseconds
sequence number = counter incrementing with each frame
timestamp = chunk.timestamp
SSRC = this.config.ssrc
*/

   Serialize(self, config) {
     return new TransformStream({
       start (controller) {
       },
       transform(chunk, controller) {
         let tid, pt, duration, timestamp;
         if (chunk.type == 'config') {
           tid = 0;
           duration = 0;
           timestamp = 0;
           pt = 0;
         } else {
           tid = chunk.temporalLayerId;
           duration = chunk.duration;
           timestamp = chunk.timestamp;
           pt = config.pt;
         }
         //Serialize the chunk
         let hdr = new ArrayBuffer( HEADER_LENGTH );
         let i = (chunk.type == 'key' ? 1 : 0);
         let lid = 0;
         let d;
         let b = (((lid == 0) && (tid == 0)) ? 1 : 0);
         // If it's a keyframe, configuration or a base layer frame, mark non-discardable
         if ((i == 1) || (b == 1) || (pt == 0)) {
           d = 0; 
         } else {
           d = 1;
         }
         let B3 = 0;
         let B2 = 192 + (i * 32) + (d * 16) + (b * 8) + tid;
         let B1 = (chunk.type == "config" ? 0 : config.pt);
         let B0 = 192;
         //self.postMessage({text: 'i : ' + i + ' d: ' + d + ' b: ' + b + ' type: ' + chunk.type + ' pt: ' +  config.pt + ' len: ' + len});
         //self.postMessage({text: 'Serial B0: ' + B0 + ' B1: ' + B1 + ' B2: ' + B2 + ' B3: ' + B3}); 
         let first4 = (B3 & 0xff) | ((B2 & 0xff) << 8) | ((B1 & 0xff) << 16) | ((B0 & 0xff) << 24);
         let sendTime = (0xffffffff & Math.trunc(1000 * performance.now()));
         writeUInt32(hdr, 4, first4);
         writeUInt32(hdr, 8, sendTime);
         writeUInt32(hdr, 12, chunk.seqNo);
         writeUInt64(hdr, 16, BigInt(timestamp));
         writeUInt32(hdr, 24, config.ssrc);
         if (chunk.type == "config") {
           let enc = new TextEncoder();
           const cfg = enc.encode(chunk.config);
           // self.postMessage({text: 'Serial Config: ' + chunk.config + ' Length: ' + cfg.length});
           let result = new Uint8Array( hdr.byteLength + cfg.length);
           let len = (cfg.length + HEADER_LENGTH) & 0xFFFFFFFF; 
           writeUInt32(hdr, 0, len); 
           result.set(new Uint8Array(hdr), 0);
           result.set(new Uint8Array(cfg), hdr.byteLength);
           //self.postMessage({text: 'Serialize now: ' + sendTime/1000. + ' seqNo: ' + chunk.seqNo + ' lid: ' + lid + ' tid: ' + tid + ' pt: 0 i: ' + i + ' d: ' + d + ' b: ' + b + ' ts: ' + timestamp + ' ssrc: ' + config.ssrc + ' actual len: ' + result.byteLength + ' pack len: ' + len});
           controller.enqueue(result.buffer);
         } else {
           let len = (chunk.byteLength + HEADER_LENGTH) & 0xFFFFFFFF;
           writeUInt32(hdr, 0, len);
           let result = new Uint8Array( hdr.byteLength + chunk.byteLength);
           result.set(new Uint8Array(hdr), 0);
           let data = new ArrayBuffer(chunk.byteLength);
           chunk.copyTo(data);
           result.set(new Uint8Array(data), hdr.byteLength);
           // self.postMessage({text: 'Serial hdr: ' + hdr.byteLength + ' chunk length: ' + chunk.byteLength + ' result length: ' + result.byteLength});
           //self.postMessage({text: 'Serialize now: ' + sendTime + ' seqNo: ' + chunk.seqNo + ' lid: ' + lid + ' tid: ' + tid + ' pt: ' + config.pt +  ' i: ' + i + ' d: ' + d + ' b: ' + b + ' ts: ' + timestamp + ' ssrc: ' + config.ssrc + ' actual len: ' + result.byteLength + ' pack len: ' + len});
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
         let newChunk;
         const first4 = readUInt32(chunk, 4);
         //self.postMessage({text: 'First4: ' + first4});
         const B0 = (first4 & 0x000000FF);
         const B1 = (first4 & 0x0000FF00) >> 8;
         const B2 = (first4 & 0x00FF0000) >> 16;
         const B3 = (first4 & 0xFF000000) >> 24;
         //self.postMessage({text: 'Deserial B0: ' + B0 + ' B1: ' + B1 + ' B2: ' + B2 + ' B3: ' + B3});
         const lid = (B0 & 0xff);
         const pt =  (B2 & 0xff);
         const tid = (B1 & 0x07);
         const i =   (B1 & 0x20)/32;
         const d =   (B1 & 0x10)/16;
         const b =   (B1 & 0x08)/8
         const len = readUInt32(chunk, 0)
         const sendTime = readUInt32(chunk, 8);
         const seqNo = readUInt32(chunk, 12);
         const timestamp = readUInt64(chunk, 16);
         const ssrc = readUInt32(chunk, 24);
         const duration = 0;
         //self.postMessage({text: 'Dserializ sendTime: ' + sendTime/1000. + ' seqNo: ' + seqNo + ' lid: ' + lid + ' tid: ' + tid + ' pt: ' + pt +  ' i: ' + i + ' d: ' + d + ' b: ' + b + ' ts: ' + timestamp + ' ssrc: ' + ssrc + ' length: ' + chunk.byteLength});
         let hydChunk;
         if (pt == 0) {
           hydChunk = {
             type: "config",
             timestamp: timestamp,
           };
           let dec = new TextDecoder();
           hydChunk.config = dec.decode(new Uint8Array(chunk, HEADER_LENGTH));
           // self.postMessage({text: 'Deserial Config: ' + hydChunk.config});
         } else {
           let data = new Uint8Array(chunk.byteLength - HEADER_LENGTH); //create Uint8Array for data
           data.set(new Uint8Array(chunk, HEADER_LENGTH));
           hydChunk = new EncodedVideoChunk ({
              type: (i == 1 ? 'key' : 'delta'),
              timestamp: timestamp,
              data: data.buffer
           });
         }
         hydChunk.sendTime = sendTime;
         hydChunk.temporalLayerId = tid;
         hydChunk.ssrc = ssrc;
         hydChunk.pt = pt;
         hydChunk.seqNo = seqNo;
         //self.postMessage({text: 'seqNo: ' + seqNo + ' Deserial hdr: ' + HEADER_LENGTH + ' + ' chunk length: ' + hydChunk.byteLength });
         if (hydChunk.seqNo == seqPointer) {
           // No holes in the sequence number space
           seqPointer++
           controller.enqueue(hydChunk); 
         } else {
           // Received chunk is not the one we are looking for
           jb_update(hydChunk);
           if (newChunk = jb_dequeue(seqPointer)) {
              //self.postMessage({text: 'seqNo: ' + newChunk.seqNo + ' chunk length: ' + newChunk.byteLength });
              seqPointer++;
              controller.enqueue(newChunk);
           }
         }
       }
     });
   }

   DecodeVideoStream(self) {
     return new TransformStream({
       start(controller) {
         this.decoder = decoder = new VideoDecoder({
           output: frame => controller.enqueue(frame),
           error: (e) => {
              self.postMessage({severity: 'fatal', text: `Decoder error: ${e.message}`});
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
              }).catch((e) => {
                 self.postMessage({severity: 'fatal', text: `Configuration error:  ${e.message}`});
              })
           } else {
             try {
              // self.postMessage({text: 'size: ' + chunk.byteLength + ' seq: ' + chunk.seqNo + ' dur: ' + chunk.duration + ' ts: ' + chunk.timestamp + ' ssrc: ' + chunk.ssrc + ' pt: ' + chunk.pt + ' tid: ' + chunk.temporalLayerId + ' type: ' + chunk.type});
               const queue = this.decoder.decodeQueueSize;
               decqueue_update(queue);
               const before = performance.now();
               this.decoder.decode(chunk);
               const after = performance.now();
               const duration = after - before;
               dec_update(duration);
             } catch (e) {
               self.postMessage({severity: 'fatal', text: 'Derror size: ' + chunk.byteLength + ' seq: ' + chunk.seqNo + ' dur: ' + chunk.duration + ' ts: ' + chunk.timestamp + ' ssrc: ' + chunk.ssrc + ' pt: ' + chunk.pt + ' tid: ' + chunk.temporalLayerId + ' type: ' + chunk.type});
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
             if (cfg.svc) {
               chunk.temporalLayerId = cfg.svc.temporalLayerId;
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

   createSendStream(self, transport) {
     return new WritableStream({
       async start(controller) {
         // called by constructor
         // test to see if transport is still usable?
         start_time = performance.now();
       },
       async write(chunk, controller) {
         let rto, srtt, rttvar, g=.1, k=4;
         let len = rtt_aggregate.all.length;
         if (len == 0) {
           srtt = rtt_min;
           rttvar = rtt_min/2;
           rto = srtt + Math.max(g, k * rttvar);
         } else {
           srtt = rtt_aggregate.srtt;
           rttvar = rtt_aggregate.rttvar;
           rto = rtt_aggregate.rto; 
         }
         //self.postMessage({text: 'SRTT: ' + srtt + ' RTTvar: ' + rttvar + ' RTO: ' + rto});
         //check what kind of frame it is and how big
         const packlen = readUInt32(chunk, 0);
         const first4 = readUInt32(chunk, 4);
         const B0 = (first4 & 0x000000FF);
         const B1 = (first4 & 0x0000FF00) >> 8;
         const B2 = (first4 & 0x00FF0000) >> 16;
         const B3 = (first4 & 0xFF000000) >> 24;
         const lid = (B0 & 0xff);
         const pt =  (B2 & 0xff);
         const tid = (B1 & 0x07);
         const i =   (B1 & 0x20)/32;
         const d =   (B1 & 0x10)/16;
         const b =   (B1 & 0x08)/8
         const seqno = readUInt32(chunk, 12);
         // Ensure rto is > 100 ms
         rto = Math.max(rto, 100.);
         if (d == 0) {
           //If the frame is non-discardable (config or base layer) set minimum much higher
           rto = 5. * rto ;
         }
         let info = {
           seqno: seqno,
           packlen: packlen,
           i: i,
           d: d,
           b: b, 
           pt: pt,
           tid: tid
         }
         writeChunk(transport, chunk, rto, info).then(
           () => {}
           ).catch((e) => {
             self.postMessage({text: `Error: ${e.message}`});
           });
         return;
       }, 
       async close(controller) {
         await transport.close();
         controller.close();
       }, 
       async abort(reason) {
         await transport.close();
         controller.close();
       } 
     });
   }

// What should happen here....
// On an incoming undirectional stream, {number: number, value: value, buffer: bnuffer} gets added to streams[].
// get_frame(streams) is called.  The function iterates over stream[], reading from stream[i].value, with returned data
// added to the frame buffer for that stream, stream[i].buffer.  If a stream is done, the stream is removed from the stream
// pool and the length of the received frame is compared to the length initially provided. If they match, the frame is enqueued.

   createReceiveStream(self, transport) {
     return new ReadableStream({
       start(controller) {
         this.streamNumber = 0;
         this.reader = transport.incomingUnidirectionalStreams.getReader();
       },
       pull(controller) {
         this.reader.read().then(({value, done}) => {
           if (done) {
             this.reader.releaseLock();
             self.postMessage({text: 'Done accepting unidirectional streams'});
             controller.close();
             return;
           } 
           let number = this.streamNumber++;
           //self.postMessage({text: 'New incoming stream # ' + number});
           get_frame(value, number).then(
             (frame) => {
               if (frame) {
                 controller.enqueue(frame);
               }
             }
           ).catch((e) => {
               this.reader.releaseLock();
               self.postMessage({severity: 'fatal', text: `Unable to open reader# ${number}: ${e.messsage}`});
               return;
           });
         });
       },
       cancel(reason){
         // called when cancel(reason) is called
         this.reader.releaseLock();
         controller.close();
         self.postMessage({severity: 'fatal', text: `Readable Stream Cancelled: ${reason}`});
       }
     });
   }

   start() {
     if (stopped) return;
     started = true;
     self.postMessage({text: 'Start method called.'});
     const promise1 =  this.inputStream
          .pipeThrough(this.EncodeVideoStream(self,this.config))
          .pipeThrough(this.Serialize(self,this.config))
          .pipeTo(this.createSendStream(self,this.transport)).then(
            () =>  {
              Promise.resolve('Receive pipeline ');
           }).catch((e) => {
             Promise.reject(e);
           });
     const promise2 =  this.createReceiveStream(self,this.transport)
          .pipeThrough(this.Deserialize(self))
          .pipeThrough(this.DecodeVideoStream(self))
          .pipeTo(this.outputStream).then(
            () =>  {
              Promise.resolve('Send pipeline ');
            }
          ).catch((e) => {
            Promise.reject(e);
          });
     Promise.all([promise1, promise2]).then(
       (values) => { self.postMessage({text: 'Resolutions: ' + JSON.stringify(values)});
       }
       ).catch((e) => { 
         self.postMessage({severity: 'fatal', text: `pipeline error: ${e.message}`}); 
       });
   }

   stop() {
     end_time = performance.now();
     const enc_stats = enc_report();
     const encqueue_stats = encqueue_report();
     const dec_stats = dec_report();
     const decqueue_stats = decqueue_report();
     const rtt_stats = rtt_report();
     const bwe_stats = bwe_report();
     self.postMessage({severity: 'chart', text: JSON.stringify(rtt_aggregate.all)});
     self.postMessage({text: 'BWE report: ' + JSON.stringify(bwe_stats)});
     self.postMessage({text: 'RTT report: ' + JSON.stringify(rtt_stats)});
     self.postMessage({text: 'Encoder Time report: ' + JSON.stringify(enc_stats)});
     self.postMessage({text: 'Encoder Queue report: ' + JSON.stringify(encqueue_stats)});
     self.postMessage({text: 'Decoder Time report: ' + JSON.stringify(dec_stats)});
     self.postMessage({text: 'Decoder Queue report: ' + JSON.stringify(decqueue_stats)});
     if (stopped) return;
     // TODO: There might be a more elegant way of closing a stream, or other
     // events to listen for.
     if (encoder.state != "closed") encoder.close();
     if (decoder.state != "closed") decoder.close();
     stopped = true;
     this.stopped = true;
     self.postMessage({text: 'stop(): encoder and decoder closed'});
     return;
   }
}
