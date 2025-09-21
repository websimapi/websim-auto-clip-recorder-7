export function createRecorder({ onNewRawClip, autoSplitOnCaptured, onIframeNavSplit }){
  let captureStream=null, recorder=null, recording=false, timeslice=1000;
  let segments=[], sessionId=Date.now(), clipStartIdx=0, splitIndices=[];
  let splitQueue = Promise.resolve(), lastSplitAt = 0;
  let heur={ interval:null, videoEl:null, canvas:null, ctx:null };

  async function pickTab(){
    try{
      captureStream = await navigator.mediaDevices.getDisplayMedia({ video:{ displaySurface:"browser", frameRate:30, cursor:"motion" }, audio:true });
      document.getElementById("btn-start").disabled=false;
      document.getElementById("btn-split").disabled=true;
      document.getElementById("btn-stop").disabled=true;
      captureStream.getVideoTracks()[0].addEventListener("ended", ()=>stop());
    }catch(e){ console.error(e); alert("Tab picking was canceled or not permitted."); }
  }

  function setupRecorder(){
    recorder = new MediaRecorder(captureStream, { mimeType:"video/webm;codecs=vp9,opus" });
    recorder.ondataavailable = e=>{ if(e.data && e.data.size>0){ const now=Date.now(); segments.push({blob:e.data, t:now}); } };
    recorder.onstop = ()=>{};
  }

  function start(){
    if(!captureStream){ alert("Pick a tab first."); return; }
    if(recording) return;
    setupRecorder(); recording=true; recorder.start(timeslice);
    document.getElementById("btn-start").disabled=true;
    document.getElementById("btn-stop").disabled=false;
    document.getElementById("btn-split").disabled=false;
    if(autoSplitOnCaptured()) startHeuristics();
  }

  function split(){
    if(!recording) return;
    const now = Date.now();
    if (now - lastSplitAt < 600) return; // debounce rapid splits
    lastSplitAt = now;
    const endIdx = segments.length;
    if (endIdx <= clipStartIdx) return; // nothing new
    splitIndices.push(endIdx);
    const s = clipStartIdx, e = endIdx;
    clipStartIdx = endIdx;
    splitQueue = splitQueue.then(()=>emitClip(s,e)).catch(()=>{});
  }

  async function emitClip(sIdx,eIdx){
    const blobs=segments.slice(sIdx,eIdx).map(s=>s.blob);
    const { concatenateClips } = await import('./composer.js');
    const composed = await concatenateClips(blobs,{ width:1280, height:720, fps:30 });
    await onNewRawClip(composed, { sessionId, startIdx:sIdx, endIdx:eIdx });
  }
  
  async function recomposeRange({ sessionId: sid, startIdx, endIdx }) {
    if (sid !== sessionId) throw new Error('Session not available for recompose');
    const s = Math.max(0, Math.min(startIdx, segments.length-1));
    const e = Math.max(s+1, Math.min(endIdx, segments.length));
    const blobs = segments.slice(s, e).map(s=>s.blob);
    const { concatenateClips } = await import('./composer.js');
    return concatenateClips(blobs, { width:1280, height:720, fps:30 });
  }
  function getBounds(s){ return { minStartIdx: 0, maxEndIdx: segments.length }; }

  function stop(){
    if(recorder && recording){
      recording=false;
      // emit trailing clip if any
      if (segments.length > clipStartIdx) {
        const s = clipStartIdx, e = segments.length;
        clipStartIdx = e;
        splitQueue = splitQueue.then(()=>emitClip(s,e)).catch(()=>{});
      }
      recorder.stop();
    }
    if(captureStream){ captureStream.getTracks().forEach(t=>t.stop()); captureStream=null; }
    document.getElementById("btn-start").disabled=!captureStream;
    document.getElementById("btn-stop").disabled=true;
    document.getElementById("btn-split").disabled=true;
    stopHeuristics();
  }

  function startHeuristics(){
    if(!captureStream) return;
    const v=document.createElement("video"); v.srcObject=captureStream; v.muted=true; v.play().catch(()=>{});
    const c=document.createElement("canvas"); c.width=64; c.height=36; const x=c.getContext("2d"); let lastSig=null,lastMute=0;
    const vt=captureStream.getVideoTracks()[0]; vt.onmute=()=>{ lastMute=Date.now(); }; vt.onunmute=()=>{ if(recording && Date.now()-lastMute<2000) split(); };
    heur.interval=setInterval(()=>{ if(!recording) return; try{ x.drawImage(v,0,0,c.width,c.height); const d=x.getImageData(0,0,c.width,c.height).data;
      let sum=0,varsum=0; for(let i=0;i<d.length;i+=4){ const g=(d[i]*0.2126+d[i+1]*0.7152+d[i+2]*0.0722); sum+=g; varsum+=g*g; }
      const n=d.length/4, mean=sum/n, std=Math.sqrt(Math.max(0,varsum/n-mean*mean)); const sig=mean+std*2; if(lastSig!==null && Math.abs(sig-lastSig)>40) split(); lastSig=sig;
    }catch{} },800);
    heur.videoEl=v; heur.canvas=c; heur.ctx=x;
  }
  function stopHeuristics(){ if(heur.interval) clearInterval(heur.interval); heur={ interval:null, videoEl:null, canvas:null, ctx:null }; }

  // hook iframe navigation auto-split
  const iframe=document.getElementById("navigator");
  if(iframe){ iframe.addEventListener("load", ()=>{ if(recording && onIframeNavSplit()) split(); }); }

  return { pickTab, start, split, stop, isRecording:()=>recording, getBounds:(clip)=>getBounds(clip.startIdx,clip.endIdx), recomposeRange:(clip)=>recomposeRange(clip) };
}