let jitter_buffer = {
   all: [],
   seqmin: Number.MAX_VALUE,
   seqmax: 0, 
}

let bwe_aggregate = {
   all: [],
   lenmin: Number.MAX_VALUE,
   lenmax: 0,
   seqmin: Number.MAX_VALUE,
   seqmax: 0,
   recvsum: 0,
}

let rtt_aggregate = {
  all: [],
  min: Number.MAX_VALUE,
  max: 0,
  sum: 0,
  sumsq: 0,
  srtt: 0,
  rttvar: 0,
  rto: 0,
};

let enc_aggregate = {
  all: [],
  min: Number.MAX_VALUE,
  max: 0,
  sum: 0,
};

let dec_aggregate = {
  all: [],
  min: Number.MAX_VALUE,
  max: 0,
  sum: 0,
};

let encqueue_aggregate = {
  all: [],
  min: Number.MAX_VALUE,
  max: 0,
  sum: 0,
};

let decqueue_aggregate = {
  all: [],
  min: Number.MAX_VALUE,
  max: 0,
  sum: 0,
};

function jb_update(chunk) {
  jitter_buffer.all.push(chunk);
  jitter_buffer.all.sort((a, b) =>  {
    return (a.seqNo - b.seqNo);
  }); 
  jitter_buffer.seqmin = jitter_buffer.all[0].seqNo;
  let len = jitter_buffer.all.length;
  jitter_buffer.seqmax = jitter_buffer.all[len-1].seqNo;
}

function jb_dequeue(pointer) {
  if (jitter_buffer.all[0].seqNo == pointer) {
     return(jitter_buffer.all.shift());
  } else {
    return;
  }
}

function bwe_update(seqno, len, rtt_new){
  bwe_aggregate.all.push([seqno, len, rtt_new]);
  bwe_aggregate.seqmin = Math.min(bwe_aggregate.seqmin, seqno);
  bwe_aggregate.seqmax = Math.max(bwe_aggregate.seqmax, seqno);
  bwe_aggregate.lenmin = Math.min(bwe_aggregate.lenmin, len);
  bwe_aggregate.lenmax = Math.max(bwe_aggregate.lenmax, len);
  bwe_aggregate.recvsum += len;
}

function rtt_update(len, rtt_new) {
  let alpha = .125, beta = .250, k = 4, g = .1;
  rtt_aggregate.all.push([len, rtt_new]);
  rtt_aggregate.min = Math.min(rtt_aggregate.min, rtt_new);
  rtt_aggregate.max = Math.max(rtt_aggregate.max, rtt_new);
  rtt_aggregate.sum += rtt_new;
  rtt_aggregate.sumsq += rtt_new * rtt_new;
  if (rtt_aggregate.all.length == 1) {
    rtt_aggregate.srtt = rtt_new;
    rtt_aggregate.rttvar = rtt_new/2.;
  } else {
    rtt_aggregate.srtt = (1 - alpha) * rtt_aggregate.srtt + alpha * rtt_new;
    rtt_aggregate.rttvar = (1 - beta) * rtt_aggregate.rttvar + beta * (Math.abs(rtt_aggregate.srtt - rtt_new));
  }
  rtt_aggregate.rto = rtt_aggregate.srtt + Math.max(g, k * rtt_aggregate.rttvar);
}

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

function bwe_report(){
  const len = bwe_aggregate.all.length;
  const seqmin = bwe_aggregate.seqmin;
  const seqmax = bwe_aggregate.seqmax;
  const lenmin = bwe_aggregate.lenmin;
  const lenmax = bwe_aggregate.lenmax;
  const recvsum = bwe_aggregate.recvsum;
  const time = end_time - start_time;
  const loss = (bwe_aggregate.seqmax - bwe_aggregate.seqmin + 1) - len ; // Calculate lost frames
  const bwu = 8 * recvsum/(time/1000); //Calculate bandwidth used in bits/second
  const bwe = 0.;
  let reorder = 0;
  for (let i = 1; i < len ; i++) {
    //count the number of times that sequence numbers arrived out of order
    if (bwe_aggregate.all[i][0] < bwe_aggregate.all[i-1][0] ) {
      reorder++;
    } 
  }
  //sort by payload length
  bwe_aggregate.all.sort((a, b) =>  {
    return (a[1] - b[1]);
  });
  const half = len >> 1;
  const f = (len + 1) >> 2;
  const t = (3 * (len + 1)) >> 2;
  const alpha1 = (len + 1)/4 - Math.trunc((len + 1)/4);
  const alpha3 = (3 * (len + 1)/4) - Math.trunc(3 * (len + 1)/4);
  const lenfquart = bwe_aggregate.all[f][1] + alpha1 * (bwe_aggregate.all[f + 1][1] - bwe_aggregate.all[f][1]);
  const lentquart = bwe_aggregate.all[t][1] + alpha3 * (bwe_aggregate.all[t + 1][1] - bwe_aggregate.all[t][1]);
  const lenmedian = len % 2 === 1 ? bwe_aggregate.all[len >> 1][1] : (bwe_aggregate.all[half - 1][1] + bwe_aggregate.all[half][1]) / 2;
  // Todo: Calculate bwe according to model.
  // Model: RTTmin = RTTtrans + (len * 8 + hdr)/bwe
  // rtt (ms), hdr (link layer + quic headers, bytes), len (app payload, bytes), bwe (bits/second), qd (queueing delay, ms)
  return {
    count: len,
    loss: loss,
    reorder: reorder,
    bwe: bwe,
    bwu: bwu,
    seqmin: seqmin,
    seqmax: seqmax,
    lenmin: lenmin,
    lenfquart: lenfquart,
    lenmedian: lenmedian,
    lentquart: lentquart,
    lenmax: lenmax,
    recvsum: recvsum,
  };
}

function rtt_report() {
  rtt_aggregate.all.sort((a, b) =>  { 
    return (a[1] - b[1]); 
  });
  const len = rtt_aggregate.all.length;
  const half = len >> 1;
  const f = (len + 1) >> 2;
  const t = (3 * (len + 1)) >> 2;
  const alpha1 = (len + 1)/4 - Math.trunc((len + 1)/4);
  const alpha3 = (3 * (len + 1)/4) - Math.trunc(3 * (len + 1)/4);
  const fquart = rtt_aggregate.all[f][1] + alpha1 * (rtt_aggregate.all[f + 1][1] - rtt_aggregate.all[f][1]);
  const tquart = rtt_aggregate.all[t][1] + alpha3 * (rtt_aggregate.all[t + 1][1] - rtt_aggregate.all[t][1]);
  const median = len % 2 === 1 ? rtt_aggregate.all[len >> 1][1] : (rtt_aggregate.all[half - 1][1] + rtt_aggregate.all[half][1]) / 2;
  const avg = rtt_aggregate.sum / len;
  const std = Math.sqrt((rtt_aggregate.sumsq - len * avg  * avg) / (len - 1));
  //self.postMessage({text: 'Data dump: ' + JSON.stringify(rtt_aggregate.all)});
  return {
     count: len,
     min: rtt_aggregate.min,
     fquart: fquart,
     avg: avg,
     median: median,
     tquart: tquart,
     max: rtt_aggregate.max,
     stdev: std,
     srtt: rtt_aggregate.srtt,
     rttvar: rtt_aggregate.rttvar,
     rto:  rtt_aggregate.rto,
  };
}

function enc_report() {
  enc_aggregate.all.sort();
  const len = enc_aggregate.all.length;
  const half = len >> 1;
  const f = (len + 1) >> 2;
  const t = (3 * (len + 1)) >> 2;
  const alpha1 = (len + 1)/4 - Math.trunc((len + 1)/4);
  const alpha3 = (3 * (len + 1)/4) - Math.trunc(3 * (len + 1)/4);
  const fquart = enc_aggregate.all[f] + alpha1 * (enc_aggregate.all[f + 1] - enc_aggregate.all[f]);
  const tquart = enc_aggregate.all[t] + alpha3 * (enc_aggregate.all[t + 1] - enc_aggregate.all[t]);
  const median = len % 2 === 1 ? enc_aggregate.all[len >> 1] : (enc_aggregate.all[half - 1] + enc_aggregate.all[half]) / 2;
  return {
     count: len,
     min: enc_aggregate.min,
     fquart: fquart,
     avg: enc_aggregate.sum / len,
     median: median,
     tquart: tquart,
     max: enc_aggregate.max,
  };
}

function encqueue_report() {
  encqueue_aggregate.all.sort();
  const len = encqueue_aggregate.all.length;
  const half = len >> 1;
  const f = (len + 1) >> 2;
  const t = (3 * (len + 1)) >> 2;
  const alpha1 = (len + 1)/4 - Math.trunc((len + 1)/4);
  const alpha3 = (3 * (len + 1)/4) - Math.trunc(3 * (len + 1)/4);
  const fquart = encqueue_aggregate.all[f] + alpha1 * (encqueue_aggregate.all[f + 1] - encqueue_aggregate.all[f]);
  const tquart = encqueue_aggregate.all[t] + alpha3 * (encqueue_aggregate.all[t + 1] - encqueue_aggregate.all[t]);
  const median = len % 2 === 1 ? encqueue_aggregate.all[len >> 1] : (encqueue_aggregate.all[half - 1] + encqueue_aggregate.all[half]) / 2;
  return {
     count: len,
     min: encqueue_aggregate.min,
     fquart: fquart,
     avg: encqueue_aggregate.sum / len,
     median: median,
     tquart: tquart,
     max: encqueue_aggregate.max,
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
  const len = dec_aggregate.all.length;
  const half = len >> 1;
  const f = (len + 1) >> 2;
  const t = (3 * (len + 1)) >> 2;
  const alpha1 = (len + 1)/4 - Math.trunc((len + 1)/4);
  const alpha3 = (3 * (len + 1)/4) - Math.trunc(3 * (len + 1)/4);
  const fquart = dec_aggregate.all[f] + alpha1 * (dec_aggregate.all[f + 1] - dec_aggregate.all[f]);
  const tquart = dec_aggregate.all[t] + alpha3 * (dec_aggregate.all[t + 1] - dec_aggregate.all[t]);
  const median = len % 2 === 1 ? dec_aggregate.all[len >> 1] : (dec_aggregate.all[half - 1] + dec_aggregate.all[half]) / 2;
  return {
     count: len,
     min: dec_aggregate.min,
     fquart: fquart,
     avg: dec_aggregate.sum / len,
     median: median,
     tquart: tquart,
     max: dec_aggregate.max,
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
  const len = decqueue_aggregate.all.length;
  const half = len >> 1;
  const f = (len + 1) >> 2;
  const t = (3 * (len + 1)) >> 2;
  const alpha1 = (len + 1)/4 - Math.trunc((len + 1)/4);
  const alpha3 = (3 * (len + 1)/4) - Math.trunc(3 * (len + 1)/4);
  const fquart = decqueue_aggregate.all[f] + alpha1 * (decqueue_aggregate.all[f + 1] - decqueue_aggregate.all[f]);
  const tquart = decqueue_aggregate.all[t] + alpha3 * (decqueue_aggregate.all[t + 1] - decqueue_aggregate.all[t]);
  const median = len % 2 === 1 ? decqueue_aggregate.all[len >> 1] : (decqueue_aggregate.all[half - 1] + decqueue_aggregate.all[half]) / 2;
  return {
     count: len,
     min: decqueue_aggregate.min,
     fquart: fquart,
     avg: decqueue_aggregate.sum / len,
     median: median,
     tquart: tquart,
     max: decqueue_aggregate.max,
  };
}

