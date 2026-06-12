import { useState, useEffect, useRef, useCallback } from "react";

// ── localStorage 저장/로드 ──
const LS_KEY = "myTimerData";
function lsSave(tasks, groups, conds, alarmCfg) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      tasks, groups, conds, alarmCfg, savedAt: new Date().toISOString()
    }));
  } catch(e) { console.warn("저장 실패", e); }
}
function lsLoad() {
  try {
    const r = localStorage.getItem(LS_KEY);
    return r ? JSON.parse(r) : null;
  } catch(e) { return null; }
}

// ── 알람 ──
// 알람은 2종류뿐입니다.
//  - "focus": 집중 종료 → 휴식 시작 (작업 전체 완료 시에도 이 소리 사용)
//  - "break": 휴식 종료 → 집중 시작
// 사용자가 public/sounds/ 폴더에 아래 이름으로 파일을 넣으면 해당 소리가 재생되고,
// 없으면 Web Audio API로 생성한 기본 비프음이 재생됩니다.
const ALARM_FILES={focus:"/sounds/focus-end.mp3",break:"/sounds/break-end.mp3"};
// 배경음악(BGM) — 세션 진행 중 재생되는 음악. 집중용/휴식용을 따로 둘 수 있습니다.
//  - "focus": 집중 시간 동안 재생
//  - "break": 짧은/긴 휴식 시간 동안 재생
const BGM_FILES={focus:"/sounds/focus-bgm.mp3",break:"/sounds/break-bgm.mp3"};
const DEF_ALARM={sound:true,vibration:true,flash:true,volume:0.7,bgm:false,bgmVolume:0.4};

// ── BGM 파일 저장(IndexedDB) ──
// 사용자가 직접 선택한 음악 파일을 브라우저에 저장해 재사용합니다.
const BGM_DB="pomodoroBgmDB", BGM_STORE="files";
function idbOpen(){
  return new Promise((res,rej)=>{
    if(typeof indexedDB==="undefined")return rej(new Error("no indexedDB"));
    const req=indexedDB.open(BGM_DB,1);
    req.onupgradeneeded=()=>req.result.createObjectStore(BGM_STORE);
    req.onsuccess=()=>res(req.result);
    req.onerror=()=>rej(req.error);
  });
}
async function idbPut(key,blob){
  const db=await idbOpen();
  return new Promise((res,rej)=>{
    const tx=db.transaction(BGM_STORE,"readwrite");
    tx.objectStore(BGM_STORE).put(blob,key);
    tx.oncomplete=()=>res();
    tx.onerror=()=>rej(tx.error);
  });
}
async function idbGet(key){
  const db=await idbOpen();
  return new Promise((res,rej)=>{
    const tx=db.transaction(BGM_STORE,"readonly");
    const req=tx.objectStore(BGM_STORE).get(key);
    req.onsuccess=()=>res(req.result);
    req.onerror=()=>rej(req.error);
  });
}
async function idbDel(key){
  const db=await idbOpen();
  return new Promise((res,rej)=>{
    const tx=db.transaction(BGM_STORE,"readwrite");
    tx.objectStore(BGM_STORE).delete(key);
    tx.oncomplete=()=>res();
    tx.onerror=()=>rej(tx.error);
  });
}
// 작업(taskId)에 사용자가 직접 선택한 파일이 있으면 그 파일을, 없으면 public/sounds/의 기본 파일을 사용
async function getBgmSrc(taskId,kind){
  try{
    const blob=await idbGet(`task_${taskId}|${kind}`);
    if(blob instanceof Blob)return URL.createObjectURL(blob);
  }catch(e){}
  return BGM_FILES[kind];
}
// BGM 페이드 인/아웃 (전환 시 겹침/끊김 방지)
function fadeAudio(audio,to,ms,cb){
  if(audio._fadeTimer)clearInterval(audio._fadeTimer);
  const from=audio.volume,steps=8,stepMs=Math.max(16,ms/steps);
  let i=0;
  audio._fadeTimer=setInterval(()=>{
    i++;
    audio.volume=Math.max(0,Math.min(1,from+(to-from)*(i/steps)));
    if(i>=steps){clearInterval(audio._fadeTimer);audio._fadeTimer=null;cb&&cb();}
  },stepMs);
}
let _actx=null;
function beep(freq=880,dur=180,delay=0,vol=0.3,type="sine"){
  try{
    _actx=_actx||new (window.AudioContext||window.webkitAudioContext)();
    if(_actx.state==="suspended")_actx.resume();
    const t0=_actx.currentTime+delay/1000;
    const o=_actx.createOscillator(),g=_actx.createGain();
    o.type=type;o.frequency.value=freq;
    g.gain.setValueAtTime(0.0001,t0);
    g.gain.exponentialRampToValueAtTime(vol,t0+0.015);
    g.gain.exponentialRampToValueAtTime(0.0001,t0+dur/1000);
    o.connect(g);g.connect(_actx.destination);
    o.start(t0);o.stop(t0+dur/1000+0.02);
  }catch(e){}
}
function beepPattern(kind,vol){
  if(kind==="focus"){beep(784,150,0,vol);beep(1047,260,180,vol);}
  else{beep(659,220,0,vol);}
}
function fireAlarm(cfg,kind,setFlashOn){
  if(!cfg)cfg=DEF_ALARM;
  if(cfg.sound){
    const a=new Audio(ALARM_FILES[kind]);
    a.volume=cfg.volume??0.7;
    let fellBack=false;
    const fb=()=>{if(fellBack)return;fellBack=true;beepPattern(kind,cfg.volume??0.3);};
    a.addEventListener("error",fb);
    a.play().catch(fb);
  }
  if(cfg.vibration&&navigator.vibrate){
    navigator.vibrate(kind==="focus"?[200,100,200]:[400]);
  }
  if(cfg.flash&&setFlashOn){
    setFlashOn(true);
    setTimeout(()=>setFlashOn(false),1500);
  }
}

// ── 상수 ──
const FOCUS="focus", SHORT="short", LONG="long";
const PH_LABEL={focus:"집중",short:"짧은 휴식",long:"긴 휴식"};
const PH_COLOR={focus:"#534AB7",short:"#1D9E75",long:"#185FA5"};
const PH_BG={focus:"#EEEDFE",short:"#E1F5EE",long:"#E6F1FB"};
const PAUSE_C="#C8C5BE";
const WDAYS=["일","월","화","수","목","금","토"];
const WEEK=["월","화","수","목","금","토","일"];
const PPM=6;
const ROPTS=[{id:"none",label:"반복 없음"},{id:"daily",label:"매일"},{id:"weekly",label:"매주"},{id:"monthly",label:"매월"}];
const DEF_CONDS=[
  {id:"great",label:"최상",desc:"오늘 컨디션 최고!",mult:1.3,icon:"ti-mood-happy"},
  {id:"normal",label:"보통",desc:"평소 루틴대로",mult:1.0,icon:"ti-mood-smile"},
  {id:"low",label:"최소",desc:"최소한만 해보자",mult:0.6,icon:"ti-mood-sad"},
];
const DEF_GROUPS=[
  {id:"exercise",label:"운동",icon:"ti-run",color:"#D85A30",bg:"#FAECE7",
   presets:[{name:"단거리 인터벌",em:30,rc:6},{name:"등산",em:120,rc:4},{name:"자전거",em:60,rc:4},{name:"근육강화",em:50,rc:5}]},
  {id:"study",label:"학습",icon:"ti-book",color:"#185FA5",bg:"#E6F1FB",
   presets:[{name:"외국어",em:40,rc:4},{name:"수학",em:60,rc:4},{name:"과학",em:50,rc:4}]},
  {id:"work",label:"업무",icon:"ti-briefcase",color:"#534AB7",bg:"#EEEDFE",
   presets:[{name:"신체적인 작업",em:60,rc:4},{name:"정신적인 작업",em:90,rc:4}]},
  {id:"selfdev",label:"자기계발",icon:"ti-seeding",color:"#3B6D11",bg:"#EAF3DE",
   presets:[{name:"독서",em:30,rc:3},{name:"명상",em:20,rc:2},{name:"강의",em:50,rc:3}]},
  {id:"etc",label:"기타",icon:"ti-dots-circle-horizontal",color:"#5F5E5A",bg:"#F1EFE8",presets:[]},
];

// ── 유틸 ──
function calcSch(em,rc) {
  const n=Math.max(1,Math.round(rc));
  const tf=Math.round(em*.8),tr=em-tf;
  const fps=Math.max(5,Math.round(tf/n));
  const lc=Math.floor(n/4),sc=Math.max(0,n-1-lc),d=sc+3*lc;
  let sb,lb;
  if(!d){sb=5;lb=15;}else{sb=Math.max(1,Math.round(tr/d));lb=Math.max(sb+1,Math.round(sb*3));}
  return{fps,sb,lb,le:4,lc,sc,total:fps*n+sb*sc+lb*lc};
}
function calcTot(fps,rc,sb,lb,le) {
  const n=Number(rc)||0,le2=Math.max(1,Number(le)||4);
  const lc=Math.floor(n/le2),sc=Math.max(0,n-1-lc);
  return{tot:(Number(fps)||0)*n+(Number(sb)||0)*sc+(Number(lb)||0)*lc,lc,sc};
}
function applyCond(task,cond) {
  const m=cond.mult||1;
  const am=Math.round(task.em*m),ar=Math.max(1,Math.round(task.rc*m));
  const s=calcSch(am,ar);
  return{...s,am,ar};
}
function fmtT(s){return String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0");}
function arcPath(pct,r=78) {
  const cx=96,cy=96,a=pct*2*Math.PI-Math.PI/2,x=cx+r*Math.cos(a),y=cy+r*Math.sin(a);
  if(pct>=1)return`M ${cx} ${cy-r} A ${r} ${r} 0 1 1 ${cx-.01} ${cy-r} Z`;
  return`M ${cx} ${cy-r} A ${r} ${r} 0 ${pct>.5?1:0} 1 ${x.toFixed(2)} ${y.toFixed(2)}`;
}
function getGrp(gs,id){return gs.find(g=>g.id===id)||gs[gs.length-1];}
function buildTL(sch,n) {
  const b=[];
  for(let i=1;i<=n;i++){
    b.push({type:FOCUS,min:sch.fps});
    if(i<n){const L=i%sch.le===0;b.push({type:L?LONG:SHORT,min:L?sch.lb:sch.sb});}
  }
  return b;
}
function emptyCfg(){return{on:false,repeat:"none",time:"08:00",weekdays:[],monthDay:1};}
function makeTask(name,em,rc,gid) {
  const s=calcSch(Number(em),Number(rc));
  return{id:Date.now(),name,em:Number(em),rc:Number(rc),gid,sch:s,done:false,goalL:"",goalS:"",quote:"",cfg:emptyCfg()};
}
function taskMatchesDay(t,wd,date,isToday) {
  const cfg=t.cfg;
  if(!cfg||!cfg.on||!cfg.time)return false;
  const rep=cfg.repeat||"none";
  if(rep==="daily")return true;
  if(rep==="weekly")return(cfg.weekdays||[]).includes(wd);
  if(rep==="monthly")return(cfg.monthDay||1)===date;
  if(rep==="none")return isToday;
  return false;
}
function getWeekDays(now,offset=0) {
  const base=new Date(now);
  const diff=now.getDay()===0?-6:1-now.getDay();
  base.setDate(base.getDate()+diff+offset*7);
  return Array.from({length:7},(_,i)=>{const d=new Date(base);d.setDate(base.getDate()+i);return d;});
}

// ── 스타일 상수 ──
const INP={padding:"6px 10px",fontSize:13,border:"1px solid #d8d5cf",borderRadius:6,background:"#f7f6f3",color:"#1a1918",boxSizing:"border-box",width:"100%"};
const LBL={fontSize:10,color:"#888",marginBottom:3};
const SECT={fontSize:11,fontWeight:600,color:"#555",marginBottom:8,textTransform:"uppercase",letterSpacing:"0.06em"};
const MWRAP={background:"rgba(0,0,0,0.5)",position:"fixed",inset:0,display:"flex",alignItems:"center",justifyContent:"center",zIndex:200,padding:16};
const MBOX={background:"#fff",borderRadius:12,border:"1px solid #e0ddd8",padding:"1.25rem",width:"100%",maxWidth:430,maxHeight:"85vh",overflowY:"auto",boxShadow:"0 12px 40px rgba(0,0,0,.25)"};

export default function App() {
  const saved = lsLoad();
  const now = new Date();

  const [tab,setTab]=useState("tasks");
  const [groups,setGroups]=useState(saved?.groups||DEF_GROUPS);
  const [conds,setConds]=useState(saved?.conds||DEF_CONDS);
  const [selGid,setSelGid]=useState("exercise");
  const [tasks,setTasks]=useState(saved?.tasks||[]);
  const [scheduleAlert,setScheduleAlert]=useState(null);
  const [confirmModal,setConfirmModal]=useState(null); // {message, onConfirm}
  function askConfirm(message,onConfirm){setConfirmModal({message,onConfirm});}
  const [showWeekly,setShowWeekly]=useState(false);
  const [weekOffset,setWeekOffset]=useState(0);
  const [editF,setEditF]=useState(null);
  const [editConds,setEditConds]=useState(DEF_CONDS);
  const [addF,setAddF]=useState(null);
  const [startMod,setStartMod]=useState(null);
  const [session,setSession]=useState(null);
  const [tLeft,setTLeft]=useState(0);
  const [running,setRunning]=useState(false);
  const [log,setLog]=useState([]);
  const [showNG,setShowNG]=useState(false);
  const [ng,setNg]=useState({label:"",icon:"ti-bulb",color:"#534AB7",bg:"#EEEDFE"});
  const [tl,setTl]=useState([]);
  const [pSegs,setPSegs]=useState([]);
  const [lSegs,setLSegs]=useState([]);
  const [pSec,setPSec]=useState(0);
  const [totPSec,setTotPSec]=useState(0);
  const [saveStatus,setSaveStatus]=useState("");
  const [alarmCfg,setAlarmCfg]=useState(saved?.alarmCfg?{...DEF_ALARM,...saved.alarmCfg}:DEF_ALARM);
  const [flashOn,setFlashOn]=useState(false);
  const [showSettings,setShowSettings]=useState(false);
  const iRef=useRef(null);
  const paRef=useRef(null);
  const bgmFocusInputRef=useRef(null);
  const bgmBreakInputRef=useRef(null);
  const alarmRef=useRef(alarmCfg);
  useEffect(()=>{alarmRef.current=alarmCfg;},[alarmCfg]);

  const selG=getGrp(groups,selGid);
  const curPhSec=session?session.phase===FOCUS?session.sch.fps*60:session.phase===SHORT?session.sch.sb*60:session.sch.lb*60:0;
  const pct=session?1-tLeft/curPhSec:0;
  const tColor=session?PH_COLOR[session.phase]:"#534AB7";
  const tlMin=tl.reduce((a,b)=>a+b.min,0);
  const s2p=PPM/60;
  const aSegs=[...pSegs,...lSegs];
  const progPx=aSegs.reduce((a,s)=>a+s.px,0);
  const addPrev=addF&&addF.em&&addF.rc&&Number(addF.rc)>0?calcSch(Number(addF.em),Number(addF.rc)):null;
  const editG=editF?getGrp(groups,editF.gid):null;
  const editTot=editF?calcTot(editF.fps,editF.rc,editF.sb,editF.lb,editF.le):null;
  const addG=addF?getGrp(groups,addF.gid):null;
  const focMin=log.reduce((a,b)=>a+b.min,0);
  const todayWd=(now.getDay()+6)%7;
  const todayDate=now.getDate();
  const todayTasks=tasks.filter(t=>taskMatchesDay(t,todayWd,todayDate,true))
    .sort((a,b)=>a.cfg.time.localeCompare(b.cfg.time));

  // 자동 저장
  useEffect(()=>{ lsSave(tasks,groups,conds,alarmCfg); },[tasks,groups,conds,alarmCfg]);

  // 예약 체크
  useEffect(()=>{
    function check(){
      const n2=new Date();
      const hhmm=String(n2.getHours()).padStart(2,"0")+":"+String(n2.getMinutes()).padStart(2,"0");
      const wd=(n2.getDay()+6)%7, date=n2.getDate();
      tasks.forEach(t=>{
        if(!t.cfg?.on||t.cfg.time!==hhmm)return;
        if(!taskMatchesDay(t,wd,date,true))return;
        if(typeof Notification!=="undefined"&&Notification.permission==="granted")
          new Notification("포모도로 시작 시간!",{body:t.name+" 작업을 시작할 시간이에요."});
        setScheduleAlert(t);
      });
    }
    if(typeof Notification!=="undefined"&&Notification.permission==="default")Notification.requestPermission();
    check();
    const id=setInterval(check,60000);
    return ()=>clearInterval(id);
  },[tasks]);

  function manualSave(){
    lsSave(tasks,groups,conds,alarmCfg);
    setSaveStatus("saved");
    setTimeout(()=>setSaveStatus(""),2000);
  }
  function manualLoad(){
    const d=lsLoad();
    if(d){
      if(d.tasks)setTasks(d.tasks);
      if(d.groups)setGroups(d.groups);
      if(d.conds)setConds(d.conds);
      if(d.alarmCfg)setAlarmCfg(d.alarmCfg);
      setSaveStatus("loaded");
      setTimeout(()=>setSaveStatus(""),2000);
    }else{ alert("저장된 데이터가 없습니다."); }
  }

  function openEdit(t){
    setEditF({...t,_em:t.em,fps:t.sch.fps,sb:t.sch.sb,lb:t.sch.lb,le:t.sch.le,schedule:t.cfg||emptyCfg(),
      bgmFocusName:t.bgmFocusName||"",bgmBreakName:t.bgmBreakName||"",_bgmFocusFile:null,_bgmBreakFile:null});
    setEditConds(conds);
  }
  async function saveEdit(){
    if(!editF)return;
    const rc=Number(editF.rc),fps=Number(editF.fps),sb=Number(editF.sb),lb=Number(editF.lb),le=Number(editF.le);
    const{tot}=calcTot(fps,rc,sb,lb,le);
    setTasks(ts=>ts.map(x=>x.id!==editF.id?x:{...x,name:editF.name,em:tot,rc,
      sch:{fps,sb,lb,le,lc:Math.floor(rc/Math.max(1,le)),sc:Math.max(0,rc-1-Math.floor(rc/Math.max(1,le))),total:tot},
      goalL:editF.goalL||"",goalS:editF.goalS||"",quote:editF.quote||"",cfg:editF.schedule||emptyCfg(),
      bgmFocusName:editF.bgmFocusName||"",bgmBreakName:editF.bgmBreakName||""}));
    setConds(editConds);
    const id=editF.id;
    if(editF._bgmFocusFile)idbPut(`task_${id}|focus`,editF._bgmFocusFile).catch(()=>{});
    else if(!editF.bgmFocusName)idbDel(`task_${id}|focus`).catch(()=>{});
    if(editF._bgmBreakFile)idbPut(`task_${id}|break`,editF._bgmBreakFile).catch(()=>{});
    else if(!editF.bgmBreakName)idbDel(`task_${id}|break`).catch(()=>{});
    setEditF(null);
  }
  function delTask(id){
    setTasks(ts=>ts.filter(x=>x.id!==id));
    setEditF(null);
    idbDel(`task_${id}|focus`).catch(()=>{});
    idbDel(`task_${id}|break`).catch(()=>{});
  }
  function acEdit(em,rc){
    if(!em||!rc||Number(rc)<1)return;
    const s=calcSch(Number(em),Number(rc));
    setEditF(f=>({...f,fps:s.fps,sb:s.sb,lb:s.lb,le:s.le}));
  }

  const tick=useCallback(()=>{
    setTLeft(prev=>{
      if(prev<=1){
        setRunning(false);clearInterval(iRef.current);
        setSession(s=>{
          if(!s)return s;
          setLSegs(ls=>{
            const col=PH_COLOR[s.phase];
            const tp=s.phase===FOCUS?s.sch.fps*PPM:s.phase===SHORT?s.sch.sb*PPM:s.sch.lb*PPM;
            const used=ls.reduce((a,x)=>a+x.px,0);
            setPSegs(ps=>[...ps,...ls,{color:col,px:Math.max(0,tp-used)},{color:"transparent",px:2}]);
            return[];
          });
          if(s.phase===FOCUS){
            const nc=s.done+1;
            setLog(l=>[...l,{name:s.name,gid:s.gid,min:s.sch.fps,num:nc,cid:s.cid,
              time:new Date().toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit"})}]);
            if(nc>=s.total){
              setTasks(ts=>ts.map(t=>t.id===s.tid?{...t,done:true}:t));
              fireAlarm(alarmRef.current,"focus",setFlashOn);
              return null;
            }
            const iL=nc%s.sch.le===0;
            setTimeout(()=>setTLeft((iL?s.sch.lb:s.sch.sb)*60),0);
            fireAlarm(alarmRef.current,"focus",setFlashOn);
            return{...s,phase:iL?LONG:SHORT,done:nc};
          }else{
            setTimeout(()=>setTLeft(s.sch.fps*60),0);
            fireAlarm(alarmRef.current,"break",setFlashOn);
            return{...s,phase:FOCUS};
          }
        });return 0;
      }
      setLSegs(ls=>{
        if(!ls.length)return[{color:PH_COLOR[FOCUS],px:s2p}];
        const last=ls[ls.length-1];
        if(last.color!==PAUSE_C)return[...ls.slice(0,-1),{...last,px:last.px+s2p}];
        return[...ls,{color:PH_COLOR[FOCUS],px:s2p}];
      });
      return prev-1;
    });
  },[s2p]);

  useEffect(()=>{
    if(running){iRef.current=setInterval(tick,1000);}
    else clearInterval(iRef.current);
    return()=>clearInterval(iRef.current);
  },[running,tick]);

  useEffect(()=>{
    if(!running&&session){
      paRef.current=setInterval(()=>{
        setPSec(p=>p+1);
        setLSegs(ls=>{
          if(!ls.length)return[{color:PAUSE_C,px:s2p}];
          const last=ls[ls.length-1];
          if(last.color===PAUSE_C)return[...ls.slice(0,-1),{...last,px:last.px+s2p}];
          return[...ls,{color:PAUSE_C,px:s2p}];
        });
      },1000);
    }else{
      clearInterval(paRef.current);
      if(running){setTotPSec(p=>p+pSec);setPSec(0);}
    }
    return()=>clearInterval(paRef.current);
  },[running,session]);

  // 배경음악(BGM) 재생 — 집중/휴식 단계에 맞춰 곡 전환
  const bgmRef=useRef(null);
  useEffect(()=>{
    if(!bgmRef.current){
      const a=new Audio();a.loop=true;a.dataset.kind="";
      a.addEventListener("error",()=>{a.dataset.kind="";});
      bgmRef.current=a;
    }
  },[]);
  const bgmUrlRef=useRef(null); // 현재 사용 중인 blob URL (해제용)
  useEffect(()=>{
    const audio=bgmRef.current;
    if(!audio)return;
    const vol=alarmCfg.bgmVolume??0.4;
    if(!alarmCfg.bgm||!session||!running){
      fadeAudio(audio,0,250,()=>audio.pause());
      return;
    }
    const tObj=tasks.find(t=>t.id===session.tid);
    const kind=session.phase===FOCUS?"focus":"break";
    const name=(kind==="focus"?tObj?.bgmFocusName:tObj?.bgmBreakName)||"";
    const key=session.tid+"|"+kind+"|"+name;
    if(audio.dataset.key===key){
      if(audio.paused){audio.volume=0;audio.play().then(()=>fadeAudio(audio,vol,300)).catch(()=>{});}
      else if(!audio._fadeTimer)audio.volume=vol;
      return;
    }
    let cancelled=false;
    // 단계 전환: 현재 곡을 부드럽게 줄인 뒤, 알람음과 겹치지 않게 잠시 쉬었다가 새 곡 시작
    fadeAudio(audio,0,250,()=>{
      audio.pause();
      setTimeout(async ()=>{
        if(cancelled)return;
        const src=await getBgmSrc(session.tid,kind);
        if(cancelled)return;
        if(bgmUrlRef.current){URL.revokeObjectURL(bgmUrlRef.current);bgmUrlRef.current=null;}
        if(src.startsWith("blob:"))bgmUrlRef.current=src;
        audio.src=src;
        audio.dataset.key=key;
        audio.currentTime=0;
        audio.volume=0;
        audio.play().then(()=>fadeAudio(audio,vol,400)).catch(()=>{});
      },900);
    });
    return ()=>{cancelled=true;};
  },[session?.phase,session?.tid,running,alarmCfg.bgm,alarmCfg.bgmVolume,tasks]);
  useEffect(()=>{
    if(!session&&bgmRef.current){
      const audio=bgmRef.current;
      fadeAudio(audio,0,250,()=>{audio.pause();audio.dataset.key="";});
    }
  },[session]);

  function startTask(task,cond){
    clearInterval(iRef.current);clearInterval(paRef.current);
    const r=applyCond(task,cond);
    const sch={fps:r.fps,sb:r.sb,lb:r.lb,le:r.le};
    setTl(buildTL(sch,r.ar));
    setPSegs([]);setLSegs([{color:PH_COLOR[FOCUS],px:0}]);
    setSession({tid:task.id,name:task.name,gid:task.gid,sch,phase:FOCUS,done:0,total:r.ar,cid:cond.id});
    setTLeft(r.fps*60);setRunning(false);setPSec(0);setTotPSec(0);
    setStartMod(null);setTab("timer");
  }
  function addGroup(){
    if(!ng.label.trim())return;
    const id="c_"+Date.now();
    setGroups(g=>[...g,{id,label:ng.label,icon:ng.icon,color:ng.color,bg:ng.bg,presets:[]}]);
    setSelGid(id);setNg({label:"",icon:"ti-bulb",color:"#534AB7",bg:"#EEEDFE"});setShowNG(false);
  }
  function delGroup(id){
    const r=groups.filter(x=>x.id!==id);
    setGroups(r);setTasks(t=>t.filter(x=>x.gid!==id));setSelGid(r[0]?.id||"");
  }
  function toggleRun(){if(!session)return;setRunning(r=>!r);}
  function resetTmr(){
    askConfirm("타이머를 리셋할까요? 진행 중인 기록은 복구할 수 없어요.",()=>{
      clearInterval(iRef.current);clearInterval(paRef.current);setRunning(false);
      if(session){setTLeft(curPhSec);setLSegs([{color:PH_COLOR[session.phase],px:0}]);}setPSec(0);
    });
  }
  function stopSes(){
    askConfirm("세션을 종료할까요? 진행 중인 기록은 복구할 수 없어요.",()=>{
      clearInterval(iRef.current);clearInterval(paRef.current);
      setRunning(false);setSession(null);setTl([]);setPSegs([]);setLSegs([]);setPSec(0);setTotPSec(0);
    });
  }

  const weekDays=getWeekDays(now,weekOffset);
  const weekData=weekDays.map((d,di)=>{
    const isToday=d.toDateString()===now.toDateString();
    return tasks.filter(t=>taskMatchesDay(t,di,d.getDate(),isToday));
  });
  const allH=weekData.flat().map(t=>parseInt(t.cfg.time));
  const minH=allH.length?Math.max(0,Math.min(...allH)-1):7;
  const maxH=allH.length?Math.min(23,Math.max(...allH)+2):22;
  const wHours=Array.from({length:maxH-minH+1},(_,i)=>minH+i);
  const PX_H=52,COL_W=60,TIME_W=34;

  return(
    <div style={{fontFamily:"system-ui,sans-serif",maxWidth:520,margin:"0 auto",padding:"1rem 0.75rem",paddingBottom:"env(safe-area-inset-bottom)"}}>
      {/* 알람 화면 깜빡임 */}
      {flashOn&&(
        <div style={{position:"fixed",inset:0,zIndex:300,pointerEvents:"none",background:tColor,animation:"alarmFlash 0.5s ease-in-out 3"}}/>
      )}

      <div style={{display:"flex",alignItems:"flex-start",gap:8,marginBottom:4}}>
        <div style={{flex:1}}>
          <h2 style={{fontSize:18,fontWeight:500,marginBottom:4}}>포모도로 타이머</h2>
          <p style={{fontSize:13,color:"#666"}}>작업을 등록하고 스마트하게 집중하세요</p>
        </div>
        <button onClick={()=>setShowSettings(true)} title="알람 설정" style={{display:"flex",alignItems:"center",gap:5,height:34,flexShrink:0,padding:"0 12px",fontSize:12,fontWeight:500,background:"#f7f6f3",color:"#534AB7",border:"1px solid #d8d5cf",borderRadius:8,cursor:"pointer"}}>⚙️ 알람설정</button>
      </div>
      <div style={{marginBottom:14}}/>

      {/* 알람 설정 팝업 */}
      {showSettings&&(
        <div style={MWRAP} onClick={e=>{if(e.target===e.currentTarget)setShowSettings(false);}}>
          <div style={MBOX}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
              <span style={{fontSize:14,fontWeight:500,color:"#534AB7",flex:1}}>🔔 알람 설정</span>
              <button onClick={()=>setShowSettings(false)} style={{background:"none",border:"none",cursor:"pointer",fontSize:22,color:"#aaa",lineHeight:1}}>×</button>
            </div>
            <p style={{fontSize:11,color:"#888",marginBottom:14}}>집중/휴식이 끝날 때 알릴 방법을 선택하세요. 여러 개를 함께 켤 수 있어요.</p>
            {[
              {k:"sound",label:"🔊 소리",desc:"비프음 또는 직접 넣은 알람음 재생"},
              {k:"vibration",label:"📳 진동",desc:"휴대폰 진동 (지원 기기에서만)"},
              {k:"flash",label:"🔴 화면 깜빡임",desc:"화면을 짧게 점멸 — 무음 환경에 적합"},
            ].map(opt=>(
              <div key={opt.k} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:"1px solid #f0ede8"}}>
                <div style={{flex:1}}>
                  <p style={{fontSize:13,fontWeight:500,margin:"0 0 2px"}}>{opt.label}</p>
                  <p style={{fontSize:11,color:"#aaa",margin:0}}>{opt.desc}</p>
                </div>
                <button onClick={()=>setAlarmCfg(c=>({...c,[opt.k]:!c[opt.k]}))}
                  style={{width:44,height:24,borderRadius:12,background:alarmCfg[opt.k]?"#534AB7":"#ccc",border:"none",cursor:"pointer",position:"relative",flexShrink:0}}>
                  <div style={{width:18,height:18,borderRadius:"50%",background:"#fff",position:"absolute",top:3,left:alarmCfg[opt.k]?23:3,transition:"left .2s",boxShadow:"0 1px 3px rgba(0,0,0,.25)"}}/>
                </button>
              </div>
            ))}
            <div style={{marginTop:12,marginBottom:14}}>
              <p style={LBL}>소리 크기</p>
              <input type="range" min="0" max="1" step="0.1" value={alarmCfg.volume??0.7}
                onChange={e=>setAlarmCfg(c=>({...c,volume:Number(e.target.value)}))}
                style={{width:"100%"}} disabled={!alarmCfg.sound}/>
            </div>
            <div style={{display:"flex",gap:8,marginBottom:14}}>
              <button onClick={()=>fireAlarm(alarmCfg,"focus",setFlashOn)} style={{flex:1,padding:"7px 0",fontSize:12,background:"#f7f6f3",color:"#534AB7",border:"1px solid #d8d5cf",borderRadius:8,cursor:"pointer"}}>집중 종료음 테스트</button>
              <button onClick={()=>fireAlarm(alarmCfg,"break",setFlashOn)} style={{flex:1,padding:"7px 0",fontSize:12,background:"#f7f6f3",color:"#1D9E75",border:"1px solid #d8d5cf",borderRadius:8,cursor:"pointer"}}>휴식 종료음 테스트</button>
            </div>
            <div style={{background:"#f7f6f3",borderRadius:8,padding:"10px 12px",fontSize:11,color:"#888",lineHeight:1.6,marginBottom:14}}>
              💡 직접 만든 알람음을 쓰고 싶다면, <code>public/sounds/</code> 폴더에 아래 이름으로 mp3 파일을 넣으세요:
              <br/>· <b>focus-end.mp3</b> — 집중 종료 → 휴식 시작 (작업 전체 완료 시에도 재생)
              <br/>· <b>break-end.mp3</b> — 휴식 종료 → 집중 시작
              <br/>파일이 없으면 자동으로 기본 비프음이 재생됩니다.
            </div>

            <p style={SECT}>배경음악 (BGM)</p>
            <div style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:"1px solid #f0ede8",marginBottom:10}}>
              <div style={{flex:1}}>
                <p style={{fontSize:13,fontWeight:500,margin:"0 0 2px"}}>🎵 세션 중 음악 재생</p>
                <p style={{fontSize:11,color:"#aaa",margin:0}}>집중용 음악과 휴식용 음악을 따로 재생해요</p>
              </div>
              <button onClick={()=>setAlarmCfg(c=>({...c,bgm:!c.bgm}))}
                style={{width:44,height:24,borderRadius:12,background:alarmCfg.bgm?"#534AB7":"#ccc",border:"none",cursor:"pointer",position:"relative",flexShrink:0}}>
                <div style={{width:18,height:18,borderRadius:"50%",background:"#fff",position:"absolute",top:3,left:alarmCfg.bgm?23:3,transition:"left .2s",boxShadow:"0 1px 3px rgba(0,0,0,.25)"}}/>
              </button>
            </div>
            <div style={{marginBottom:14}}>
              <p style={LBL}>BGM 음량</p>
              <input type="range" min="0" max="1" step="0.1" value={alarmCfg.bgmVolume??0.4}
                onChange={e=>setAlarmCfg(c=>({...c,bgmVolume:Number(e.target.value)}))}
                style={{width:"100%"}} disabled={!alarmCfg.bgm}/>
            </div>
            <div style={{background:"#f7f6f3",borderRadius:8,padding:"10px 12px",fontSize:11,color:"#888",lineHeight:1.6}}>
              💡 <code>public/sounds/</code> 폴더에 아래 이름으로 mp3 파일을 넣으면 타이머 진행 중 기본으로 재생됩니다:
              <br/>· <b>focus-bgm.mp3</b> — 집중 시간 동안 재생할 음악
              <br/>· <b>break-bgm.mp3</b> — 휴식 시간 동안 재생할 음악
              <br/>각 작업마다 다른 음악을 쓰고 싶다면, 작업 수정 화면의 "배경음악"에서 파일을 직접 선택할 수 있어요. 선택하지 않으면 위 기본 음악이 재생됩니다.
            </div>
          </div>
        </div>
      )}

      {/* 탭 */}
      <div style={{display:"flex",gap:6,marginBottom:18}}>
        {["tasks","timer","report"].map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{flex:1,padding:"8px 0",fontSize:13,fontWeight:tab===t?500:400,background:tab===t?"#534AB7":"transparent",color:tab===t?"#fff":"#666",border:`1px solid ${tab===t?"#534AB7":"#d8d5cf"}`,borderRadius:8,cursor:"pointer"}}>
            {t==="tasks"?"작업 목록":t==="timer"?"타이머":"분석"}
          </button>
        ))}
      </div>

      {/* 주간 캘린더 팝업 */}
      {showWeekly&&(
        <div style={{...MWRAP,alignItems:"flex-start",paddingTop:20}} onClick={e=>{if(e.target===e.currentTarget)setShowWeekly(false);}}>
          <div style={{background:"#fff",borderRadius:12,border:"1px solid #e0ddd8",width:"100%",maxWidth:560,maxHeight:"90vh",display:"flex",flexDirection:"column",boxShadow:"0 12px 40px rgba(0,0,0,.25)"}}>
            <div style={{display:"flex",alignItems:"center",padding:"12px 16px",borderBottom:"1px solid #f0ede8",flexShrink:0,gap:6}}>
              <span style={{fontSize:14,fontWeight:600,flex:1}}>주간 캘린더</span>
              <button onClick={()=>setWeekOffset(o=>o-1)} style={{padding:"4px 8px",fontSize:11,background:"#f7f6f3",border:"1px solid #d8d5cf",borderRadius:6,cursor:"pointer"}}>← 이전</button>
              <button onClick={()=>setWeekOffset(0)} style={{padding:"4px 8px",fontSize:11,background:weekOffset===0?"#534AB7":"#f7f6f3",color:weekOffset===0?"#fff":"#666",border:`1px solid ${weekOffset===0?"#534AB7":"#d8d5cf"}`,borderRadius:6,cursor:"pointer"}}>이번 주</button>
              <button onClick={()=>setWeekOffset(o=>o+1)} style={{padding:"4px 8px",fontSize:11,background:"#f7f6f3",border:"1px solid #d8d5cf",borderRadius:6,cursor:"pointer"}}>다음 →</button>
              <button onClick={()=>setShowWeekly(false)} style={{background:"none",border:"none",cursor:"pointer",fontSize:22,color:"#aaa",lineHeight:1}}>×</button>
            </div>
            <div style={{display:"flex",borderBottom:"1px solid #f0ede8",flexShrink:0,paddingLeft:TIME_W}}>
              {weekDays.map((d,di)=>{
                const isToday=d.toDateString()===now.toDateString();
                return(
                  <div key={di} style={{width:COL_W,flexShrink:0,textAlign:"center",padding:"6px 2px"}}>
                    <div style={{fontSize:10,color:di>=5?"#E24B4A":"#aaa",marginBottom:2}}>{WEEK[di]}</div>
                    <div style={{width:26,height:26,borderRadius:"50%",background:isToday?"#534AB7":"transparent",margin:"0 auto",display:"flex",alignItems:"center",justifyContent:"center"}}>
                      <span style={{fontSize:12,fontWeight:600,color:isToday?"#fff":di>=5?"#E24B4A":"#333"}}>{d.getDate()}</span>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{overflowY:"auto",flex:1}}>
              <div style={{display:"flex",minHeight:wHours.length*PX_H}}>
                <div style={{width:TIME_W,flexShrink:0}}>
                  {wHours.map(h=>(
                    <div key={h} style={{height:PX_H,display:"flex",alignItems:"flex-start",justifyContent:"flex-end",paddingRight:4,paddingTop:4,boxSizing:"border-box"}}>
                      <span style={{fontSize:9,color:"#bbb"}}>{String(h).padStart(2,"0")}:00</span>
                    </div>
                  ))}
                </div>
                {weekDays.map((d,di)=>{
                  const isToday=d.toDateString()===now.toDateString();
                  return(
                    <div key={di} style={{width:COL_W,flexShrink:0,position:"relative",borderLeft:"1px solid #f0ede8",background:isToday?"#f9f8ff":di>=5?"#fffaf9":"#fff"}}>
                      {wHours.map(h=><div key={h} style={{height:PX_H,borderBottom:"1px solid #f5f3f0",boxSizing:"border-box"}}/>)}
                      {weekData[di].map(t=>{
                        const[tH,tM]=t.cfg.time.split(":").map(Number);
                        const topPx=((tH-minH)*60+tM)/60*PX_H;
                        const blockH=Math.max(22,t.em/60*PX_H);
                        const g2=getGrp(groups,t.gid);
                        return(
                          <div key={t.id} title={t.cfg.time+" "+t.name}
                            style={{position:"absolute",top:topPx,left:2,right:2,height:blockH,background:g2.color,borderRadius:5,padding:"3px 4px",overflow:"hidden",zIndex:1,boxShadow:"0 1px 4px rgba(0,0,0,.15)"}}>
                            <p style={{fontSize:9,fontWeight:700,color:"#fff",margin:"0 0 1px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.cfg.time}</p>
                            <p style={{fontSize:9,color:"rgba(255,255,255,.9)",margin:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.name}</p>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 수정 팝업 */}
      {editF&&editG&&(
        <div style={MWRAP} onClick={e=>{if(e.target===e.currentTarget)setEditF(null);}}>
          <div style={MBOX}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
              <span style={{fontSize:14,fontWeight:500,color:editG.color,flex:1}}>{editG.label} — 수정</span>
              <button onClick={()=>setEditF(null)} style={{background:"none",border:"none",cursor:"pointer",fontSize:22,color:"#aaa",lineHeight:1}}>×</button>
            </div>
            <p style={SECT}>기본 정보</p>
            <p style={LBL}>작업 이름</p>
            <input value={editF.name} onChange={e=>setEditF(f=>({...f,name:e.target.value}))} style={{...INP,marginBottom:8}}/>
            <div style={{display:"flex",gap:8,marginBottom:12}}>
              <div style={{flex:1}}><p style={LBL}>예상 시간(분)</p>
                <input type="number" min="1" value={editF._em||""} onChange={e=>{setEditF(f=>({...f,_em:e.target.value}));acEdit(e.target.value,editF.rc);}} style={INP}/></div>
              <div style={{flex:1}}><p style={LBL}>반복 횟수</p>
                <input type="number" min="1" value={editF.rc} onChange={e=>{setEditF(f=>({...f,rc:e.target.value}));acEdit(editF._em,e.target.value);}} style={INP}/></div>
            </div>
            <p style={SECT}>세부 설정</p>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
              {[{k:"fps",l:"집중(분)"},{k:"sb",l:"짧은 휴식(분)"},{k:"lb",l:"긴 휴식(분)"},{k:"le",l:"긴 휴식 주기"}].map(({k,l})=>(
                <div key={k}><p style={LBL}>{l}</p>
                  <input type="number" min="1" value={editF[k]||""} onChange={e=>setEditF(f=>({...f,[k]:e.target.value}))} style={{...INP,fontWeight:500}}/></div>
              ))}
            </div>
            {editTot&&Number(editF.rc)>0&&Number(editF.fps)>0&&(
              <div style={{fontSize:11,color:"#555",background:"#f7f6f3",borderRadius:6,padding:"6px 10px",marginBottom:14}}>
                <span style={{fontWeight:600}}>총 {editTot.tot}분</span>
                <span style={{marginLeft:6,color:"#888"}}>= 집중 {editF.fps}×{editF.rc} + 짧은 {editF.sb}×{editTot.sc} + 긴 {editF.lb}×{editTot.lc}</span>
              </div>
            )}
            <p style={SECT}>예약</p>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:editF.schedule?.on?10:14}}>
              <span style={{fontSize:13,flex:1}}>예약 실행</span>
              <button onClick={()=>setEditF(f=>({...f,schedule:{...(f.schedule||emptyCfg()),on:!f.schedule?.on}}))}
                style={{width:44,height:24,borderRadius:12,background:editF.schedule?.on?editG.color:"#ccc",border:"none",cursor:"pointer",position:"relative"}}>
                <div style={{width:18,height:18,borderRadius:"50%",background:"#fff",position:"absolute",top:3,left:editF.schedule?.on?23:3,transition:"left .2s",boxShadow:"0 1px 3px rgba(0,0,0,.25)"}}/>
              </button>
            </div>
            {editF.schedule?.on&&(
              <div style={{background:"#f7f6f3",borderRadius:8,padding:"10px 12px",marginBottom:14}}>
                <div style={{marginBottom:10}}><p style={LBL}>시작 시간</p>
                  <input type="time" value={editF.schedule?.time||"08:00"} onChange={e=>setEditF(f=>({...f,schedule:{...f.schedule,time:e.target.value}}))} style={INP}/></div>
                <p style={LBL}>반복</p>
                <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>
                  {ROPTS.map(o=>(
                    <button key={o.id} onClick={()=>setEditF(f=>({...f,schedule:{...f.schedule,repeat:o.id}}))}
                      style={{padding:"4px 10px",fontSize:12,background:editF.schedule?.repeat===o.id?editG.color:"transparent",color:editF.schedule?.repeat===o.id?"#fff":editG.color,border:`1px solid ${editG.color}`,borderRadius:20,cursor:"pointer"}}>
                      {o.label}
                    </button>
                  ))}
                </div>
                {editF.schedule?.repeat==="weekly"&&(
                  <div>
                    <p style={{...LBL,marginBottom:6}}>수행 요일</p>
                    <div style={{display:"flex",gap:4}}>
                      {WEEK.map((d,i)=>{
                        const chk=(editF.schedule?.weekdays||[]).includes(i);
                        return(
                          <button key={d} onClick={()=>setEditF(f=>{
                            const cur=f.schedule?.weekdays||[];
                            const next=chk?cur.filter(x=>x!==i):[...cur,i].sort((a,b)=>a-b);
                            return{...f,schedule:{...f.schedule,weekdays:next}};
                          })} style={{width:34,height:34,borderRadius:"50%",fontSize:12,fontWeight:500,
                            background:chk?editG.color:"#fff",color:chk?"#fff":i>=5?"#E24B4A":"#555",
                            border:`1px solid ${chk?editG.color:i>=5?"#E24B4A80":"#d8d5cf"}`,cursor:"pointer"}}>
                            {d}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                {editF.schedule?.repeat==="monthly"&&(
                  <div>
                    <p style={{...LBL,marginBottom:6}}>수행 날짜</p>
                    <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                      {Array.from({length:31},(_,i)=>i+1).map(d=>{
                        const chk=(editF.schedule?.monthDay||1)===d;
                        return(
                          <button key={d} onClick={()=>setEditF(f=>({...f,schedule:{...f.schedule,monthDay:d}}))}
                            style={{width:30,height:30,borderRadius:6,fontSize:11,fontWeight:500,
                              background:chk?editG.color:"#fff",color:chk?"#fff":"#555",
                              border:`1px solid ${chk?editG.color:"#d8d5cf"}`,cursor:"pointer"}}>
                            {d}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
            <p style={SECT}>목표 & 명언</p>
            <p style={LBL}>장기 목표</p><input value={editF.goalL||""} onChange={e=>setEditF(f=>({...f,goalL:e.target.value}))} placeholder="예: 마라톤 완주" style={{...INP,marginBottom:8}}/>
            <p style={LBL}>단기 목표</p><input value={editF.goalS||""} onChange={e=>setEditF(f=>({...f,goalS:e.target.value}))} placeholder="예: 오늘 5km" style={{...INP,marginBottom:8}}/>
            <p style={LBL}>명언</p><input value={editF.quote||""} onChange={e=>setEditF(f=>({...f,quote:e.target.value}))} placeholder='"시작이 반이다"' style={{...INP,marginBottom:14}}/>
            <p style={SECT}>배경음악</p>
            <p style={LBL}>집중 음악</p>
            <input ref={bgmFocusInputRef} type="file" accept="audio/*" style={{display:"none"}}
              onChange={e=>{
                const file=e.target.files?.[0];
                if(file)setEditF(f=>({...f,bgmFocusName:file.name,_bgmFocusFile:file}));
                e.target.value="";
              }}/>
            <div style={{display:"flex",gap:8,marginBottom:8}}>
              <div onClick={()=>bgmFocusInputRef.current?.click()}
                style={{...INP,flex:1,cursor:"pointer",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:editF.bgmFocusName?"#08060d":"#aaa"}}>
                {editF.bgmFocusName||"기본 음악 사용 (클릭하여 파일 선택)"}
              </div>
              {editF.bgmFocusName&&(
                <button onClick={()=>setEditF(f=>({...f,bgmFocusName:"",_bgmFocusFile:null}))}
                  style={{padding:"0 12px",fontSize:12,background:"transparent",color:"#E24B4A",border:"1px solid #E24B4A50",borderRadius:8,cursor:"pointer"}}>×</button>
              )}
            </div>
            <p style={LBL}>휴식 음악</p>
            <input ref={bgmBreakInputRef} type="file" accept="audio/*" style={{display:"none"}}
              onChange={e=>{
                const file=e.target.files?.[0];
                if(file)setEditF(f=>({...f,bgmBreakName:file.name,_bgmBreakFile:file}));
                e.target.value="";
              }}/>
            <div style={{display:"flex",gap:8,marginBottom:4}}>
              <div onClick={()=>bgmBreakInputRef.current?.click()}
                style={{...INP,flex:1,cursor:"pointer",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:editF.bgmBreakName?"#08060d":"#aaa"}}>
                {editF.bgmBreakName||"기본 음악 사용 (클릭하여 파일 선택)"}
              </div>
              {editF.bgmBreakName&&(
                <button onClick={()=>setEditF(f=>({...f,bgmBreakName:"",_bgmBreakFile:null}))}
                  style={{padding:"0 12px",fontSize:12,background:"transparent",color:"#E24B4A",border:"1px solid #E24B4A50",borderRadius:8,cursor:"pointer"}}>×</button>
              )}
            </div>
            <p style={{fontSize:10,color:"#aaa",marginBottom:14}}>⚙️ 알람설정의 "세션 중 음악 재생"이 켜져 있어야 동작하며, 파일을 선택하지 않으면 기본 BGM(focus-bgm / break-bgm)이 재생됩니다.</p>
            <p style={SECT}>컨디션 배율</p>
            <div style={{marginBottom:14}}>
              {editConds.map((c,i)=>(
                <div key={c.id} style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                  <span style={{fontSize:12,flex:1}}>{c.label}</span>
                  <div style={{display:"flex"}}>
                    <button type="button"
                      onClick={()=>setEditConds(cs=>cs.map((x,xi)=>xi===i?{...x,mult:Math.max(0.1,Math.round((x.mult-0.1)*10)/10)}:x))}
                      style={{width:26,border:"1px solid #d8d5cf",borderRight:"none",borderRadius:"6px 0 0 6px",background:"#e8e5df",color:"#1a1918",cursor:"pointer",fontSize:12,display:"flex",alignItems:"center",justifyContent:"center"}}>▼</button>
                    <input type="number" min="0.1" max="3" step="0.1" value={c.mult}
                      onChange={e=>setEditConds(cs=>cs.map((x,xi)=>xi===i?{...x,mult:Number(e.target.value)}:x))}
                      className="no-spinner"
                      style={{width:48,padding:"4px 8px",fontSize:12,border:"1px solid #d8d5cf",borderLeft:"none",borderRight:"none",borderRadius:0,background:"#f7f6f3",color:"#1a1918",textAlign:"center"}}/>
                    <button type="button"
                      onClick={()=>setEditConds(cs=>cs.map((x,xi)=>xi===i?{...x,mult:Math.min(3,Math.round((x.mult+0.1)*10)/10)}:x))}
                      style={{width:26,border:"1px solid #d8d5cf",borderLeft:"none",borderRadius:"0 6px 6px 0",background:"#e8e5df",color:"#1a1918",cursor:"pointer",fontSize:12,display:"flex",alignItems:"center",justifyContent:"center"}}>▲</button>
                  </div>
                  <input value={c.desc} onChange={e=>setEditConds(cs=>cs.map((x,xi)=>xi===i?{...x,desc:e.target.value}:x))}
                    style={{width:100,padding:"4px 8px",fontSize:11,border:"1px solid #d8d5cf",borderRadius:6,background:"#f7f6f3",color:"#666"}}/>
                </div>
              ))}
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={saveEdit} style={{flex:1,padding:"8px 0",fontSize:13,background:editG.color,color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontWeight:500}}>저장</button>
              <button onClick={()=>setEditF(null)} style={{padding:"8px 14px",fontSize:13,background:"transparent",color:"#888",border:"1px solid #d8d5cf",borderRadius:8,cursor:"pointer"}}>취소</button>
              <button onClick={()=>delTask(editF.id)} style={{padding:"8px 14px",fontSize:13,background:"transparent",color:"#E24B4A",border:"1px solid #E24B4A80",borderRadius:8,cursor:"pointer"}}>삭제</button>
            </div>
          </div>
        </div>
      )}

      {/* 추가 팝업 */}
      {addF&&addG&&(
        <div style={MWRAP} onClick={e=>{if(e.target===e.currentTarget)setAddF(null);}}>
          <div style={{...MBOX,maxWidth:360}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
              <span style={{fontSize:14,fontWeight:500,color:addG.color,flex:1}}>새 작업 — {addG.label}</span>
              <button onClick={()=>setAddF(null)} style={{background:"none",border:"none",cursor:"pointer",fontSize:22,color:"#aaa",lineHeight:1}}>×</button>
            </div>
            <p style={LBL}>작업 이름</p>
            <input value={addF.name} onChange={e=>setAddF(f=>({...f,name:e.target.value}))} style={{...INP,marginBottom:8}}/>
            <div style={{display:"flex",gap:8,marginBottom:6}}>
              <div style={{flex:1}}><p style={LBL}>예상 시간(분)</p><input type="number" min="1" value={addF.em} onChange={e=>setAddF(f=>({...f,em:e.target.value}))} style={INP}/></div>
              <div style={{flex:1}}><p style={LBL}>반복 횟수</p><input type="number" min="1" value={addF.rc} onChange={e=>setAddF(f=>({...f,rc:e.target.value}))} style={INP}/></div>
            </div>
            {addPrev&&<div style={{fontSize:11,color:"#555",background:"#f7f6f3",borderRadius:6,padding:"6px 10px",marginBottom:10}}>
              집중 {addPrev.fps}분×{addF.rc}회 · 짧은휴식 {addPrev.sb}분 · 긴휴식 {addPrev.lb}분 · <b>총 {addPrev.total}분</b>
            </div>}
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>{if(!addF.name||!addF.em||!addF.rc)return;setTasks(ts=>[...ts,makeTask(addF.name,addF.em,addF.rc,addF.gid)]);setAddF(null);}}
                style={{flex:1,padding:"7px 0",fontSize:13,background:addG.color,color:"#fff",border:"none",borderRadius:8,cursor:"pointer"}}>추가</button>
              <button onClick={()=>setAddF(null)} style={{padding:"7px 14px",fontSize:13,background:"transparent",color:"#888",border:"1px solid #d8d5cf",borderRadius:8,cursor:"pointer"}}>취소</button>
            </div>
          </div>
        </div>
      )}

      {/* 컨디션 모달 */}
      {startMod&&(
        <div style={MWRAP} onClick={e=>{if(e.target===e.currentTarget)setStartMod(null);}}>
          <div style={MBOX}>
            <p style={{fontSize:14,fontWeight:500,marginBottom:4}}>{startMod.name}</p>
            <p style={{fontSize:12,color:"#666",marginBottom:14}}>오늘 컨디션을 선택하세요</p>
            {conds.map(cond=>{
              const r=applyCond(startMod,cond);
              const{tot}=calcTot(r.fps,r.ar,r.sb,r.lb,4);
              return(
                <button key={cond.id} onClick={()=>startTask(startMod,cond)}
                  style={{width:"100%",display:"flex",alignItems:"center",gap:12,padding:"10px 14px",marginBottom:8,background:"#f7f6f3",border:"1px solid #e0ddd8",borderRadius:8,cursor:"pointer",textAlign:"left"}}>
                  <div style={{flex:1}}>
                    <p style={{fontSize:13,fontWeight:500,margin:"0 0 2px"}}>{cond.label} <span style={{fontSize:11,fontWeight:400,color:"#888"}}>— {cond.desc}</span></p>
                    <p style={{fontSize:11,color:"#666",margin:0}}>집중 {r.fps}분×{r.ar}회 · 총 {tot}분</p>
                  </div>
                </button>
              );
            })}
            <button onClick={()=>setStartMod(null)} style={{width:"100%",marginTop:4,padding:"7px 0",fontSize:12,background:"transparent",color:"#888",border:"1px solid #d8d5cf",borderRadius:8,cursor:"pointer"}}>취소</button>
          </div>
        </div>
      )}

      {/* ── 작업 목록 ── */}
      {tab==="tasks"&&(
        <div>
          {scheduleAlert&&(
            <div style={{background:"#534AB7",borderRadius:10,padding:"12px 16px",marginBottom:14,display:"flex",alignItems:"center",gap:12}}>
              <span style={{fontSize:18}}>⏰</span>
              <div style={{flex:1}}>
                <p style={{fontSize:13,fontWeight:600,color:"#fff",margin:"0 0 1px"}}>{scheduleAlert.name} 시작 시간!</p>
                <p style={{fontSize:11,color:"rgba(255,255,255,.75)",margin:0}}>집중 {scheduleAlert.sch.fps}분 × {scheduleAlert.rc}회</p>
              </div>
              <button onClick={()=>{setStartMod(scheduleAlert);setScheduleAlert(null);}} style={{fontSize:12,padding:"5px 12px",background:"#fff",color:"#534AB7",border:"none",borderRadius:6,cursor:"pointer",fontWeight:600}}>시작</button>
              <button onClick={()=>setScheduleAlert(null)} style={{fontSize:20,background:"none",border:"none",color:"rgba(255,255,255,.6)",cursor:"pointer",lineHeight:1}}>×</button>
            </div>
          )}

          {todayTasks.length>0&&(
            <div style={{background:"#fff",border:"1px solid #e0ddd8",borderRadius:10,padding:"12px 14px",marginBottom:14}}>
              <p style={{fontSize:12,fontWeight:600,color:"#555",marginBottom:10}}>📅 오늘의 일정</p>
              {todayTasks.map(t=>{
                const g2=getGrp(groups,t.gid);
                return(
                  <div key={t.id} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 0",borderBottom:"1px solid #f0ede8"}}>
                    <span style={{fontSize:13,fontWeight:600,color:"#534AB7",minWidth:44}}>{t.cfg.time}</span>
                    <div style={{width:2,height:30,background:g2.color,borderRadius:2,flexShrink:0}}/>
                    <p style={{fontSize:13,fontWeight:500,margin:0,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.name}</p>
                    <button onClick={()=>setStartMod(t)} style={{fontSize:11,padding:"4px 12px",background:g2.color,color:"#fff",border:"none",borderRadius:6,cursor:"pointer",flexShrink:0}}>시작</button>
                  </div>
                );
              })}
            </div>
          )}

          {/* 주간 캘린더 */}
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14,padding:"10px 14px",background:"#fff",borderRadius:10,border:"1px solid #e0ddd8"}}>
            <div style={{flex:1}}>
              <p style={{fontSize:12,fontWeight:600,color:"#3B6D11",margin:"0 0 2px"}}>📅 주간 캘린더</p>
              <p style={{fontSize:11,color:"#aaa",margin:0}}>예약 작업과 여유 시간 확인</p>
            </div>
            <button onClick={()=>{setWeekOffset(0);setShowWeekly(true);}} style={{fontSize:12,padding:"6px 14px",background:"#3B6D11",color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontWeight:500}}>주간 보기</button>
          </div>

          {/* 저장 */}
          <div style={{marginBottom:14,padding:"10px 14px",background:"#f7f6f3",borderRadius:10,border:"1px solid #e0ddd8",display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:12,color:"#666",flex:1}}>
              {saveStatus==="saved"?"✅ 저장 완료":saveStatus==="loaded"?"✅ 불러오기 완료":"MyTimer — 자동 저장"}
            </span>
            <button onClick={manualSave} style={{fontSize:11,padding:"5px 12px",background:"#534AB7",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontWeight:500}}>💾 저장</button>
            <button onClick={manualLoad} style={{fontSize:11,padding:"5px 12px",background:"#fff",color:"#534AB7",border:"1px solid #534AB7",borderRadius:6,cursor:"pointer"}}>📂 불러오기</button>
          </div>

          {/* 그룹 탭 */}
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:14}}>
            {groups.map(g=>(
              <button key={g.id} onClick={()=>setSelGid(g.id)} style={{display:"flex",alignItems:"center",gap:5,padding:"5px 12px",fontSize:12,fontWeight:selGid===g.id?500:400,background:selGid===g.id?g.color:"transparent",color:selGid===g.id?"#fff":g.color,border:`1px solid ${g.color}`,borderRadius:20,cursor:"pointer"}}>
                {g.label} <span style={{fontSize:10,opacity:.8}}>({tasks.filter(t=>t.gid===g.id).length})</span>
              </button>
            ))}
            <button onClick={()=>setShowNG(s=>!s)} style={{padding:"5px 12px",fontSize:12,background:"transparent",color:"#aaa",border:"1px dashed #d8d5cf",borderRadius:20,cursor:"pointer"}}>+ 그룹</button>
          </div>

          {showNG&&(
            <div style={{background:"#f7f6f3",border:"1px solid #e0ddd8",borderRadius:10,padding:"12px 14px",marginBottom:14}}>
              <p style={{fontSize:12,fontWeight:500,color:"#555",marginBottom:10}}>새 그룹</p>
              <input value={ng.label} onChange={e=>setNg(g=>({...g,label:e.target.value}))} placeholder="그룹 이름" style={{...INP,marginBottom:8}}/>
              <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
                {["#534AB7","#D85A30","#185FA5","#3B6D11","#993556","#1D9E75"].map(c=>(
                  <button key={c} onClick={()=>setNg(g=>({...g,color:c}))} style={{width:28,height:28,borderRadius:"50%",background:c,border:ng.color===c?"3px solid #333":"2px solid transparent",cursor:"pointer"}}/>
                ))}
              </div>
              <div style={{display:"flex",gap:8}}>
                <button onClick={addGroup} style={{flex:1,padding:"6px 0",fontSize:13,background:ng.color,color:"#fff",border:"none",borderRadius:8,cursor:"pointer"}}>추가</button>
                <button onClick={()=>setShowNG(false)} style={{padding:"6px 14px",fontSize:13,background:"transparent",color:"#888",border:"1px solid #d8d5cf",borderRadius:8,cursor:"pointer"}}>취소</button>
              </div>
            </div>
          )}

          <div style={{background:"#fff",border:`1px solid ${selG.color}40`,borderRadius:12,padding:"1rem 1.25rem"}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
              <span style={{fontSize:14,fontWeight:500,color:selG.color,flex:1}}>{selG.label}</span>
              <span style={{fontSize:11,color:"#aaa"}}>{tasks.filter(t=>t.gid===selGid).length}개</span>
              {!DEF_GROUPS.find(g=>g.id===selGid)&&(
                <button onClick={()=>delGroup(selGid)} style={{fontSize:11,padding:"3px 8px",background:"transparent",color:"#aaa",border:"1px solid #e0ddd8",borderRadius:6,cursor:"pointer"}}>삭제</button>
              )}
            </div>
            {selG.presets.length>0&&(
              <div style={{marginBottom:12}}>
                <p style={{fontSize:11,color:"#aaa",marginBottom:6}}>빠른 추가</p>
                <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                  {selG.presets.map(p=>(
                    <button key={p.name} onClick={()=>setTasks(ts=>[...ts,makeTask(p.name,p.em,p.rc,selGid)])}
                      style={{fontSize:11,padding:"4px 10px",background:selG.bg,color:selG.color,border:`1px solid ${selG.color}50`,borderRadius:6,cursor:"pointer"}}>+ {p.name}</button>
                  ))}
                </div>
              </div>
            )}
            {tasks.filter(t=>t.gid===selGid).map(task=>{
              const g2=getGrp(groups,task.gid);
              const sc=task.cfg;
              return(
                <div key={task.id} style={{padding:"10px 0",borderBottom:"1px solid #f0ede8"}}>
                  <div style={{display:"flex",alignItems:"flex-start",gap:10}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                        <p style={{fontSize:13,fontWeight:500,margin:0,color:task.done?"#1D9E75":"#1a1918",textDecoration:task.done?"line-through":"none"}}>{task.name}</p>
                        {sc?.on&&<span style={{fontSize:9,padding:"2px 6px",background:g2.bg,color:g2.color,border:`1px solid ${g2.color}50`,borderRadius:20,flexShrink:0}}>{sc.time}</span>}
                      </div>
                      <p style={{fontSize:11,color:"#888",margin:"2px 0 0"}}>집중 {task.sch.fps}분×{task.rc}회 · {task.em}분</p>
                      {task.goalL&&<p style={{fontSize:10,color:"#aaa",margin:"2px 0 0"}}>🎯 {task.goalL}</p>}
                    </div>
                    <div style={{display:"flex",gap:5,flexShrink:0}}>
                      <button onClick={()=>openEdit(task)} style={{fontSize:11,padding:"4px 10px",background:"#f7f6f3",color:"#555",border:"1px solid #d8d5cf",borderRadius:6,cursor:"pointer"}}>수정</button>
                      {task.done
                        ?<span style={{fontSize:11,color:"#1D9E75",background:"#E1F5EE",padding:"4px 10px",borderRadius:6}}>완료</span>
                        :<button onClick={()=>setStartMod(task)} style={{fontSize:11,padding:"4px 12px",background:g2.color,color:"#fff",border:"none",borderRadius:6,cursor:"pointer"}}>시작</button>
                      }
                      <button onClick={()=>delTask(task.id)} style={{fontSize:11,padding:"4px 10px",background:"transparent",color:"#E24B4A",border:"1px solid #E24B4A50",borderRadius:6,cursor:"pointer"}}>삭제</button>
                    </div>
                  </div>
                </div>
              );
            })}
            {tasks.filter(t=>t.gid===selGid).length===0&&selG.presets.length===0&&(
              <p style={{fontSize:12,color:"#aaa",margin:"4px 0 12px"}}>아직 등록된 작업이 없습니다.</p>
            )}
            <button onClick={()=>setAddF({gid:selGid,name:"",em:"",rc:""})}
              style={{width:"100%",marginTop:12,padding:"8px 0",fontSize:13,background:"transparent",color:selG.color,border:`1px dashed ${selG.color}`,borderRadius:8,cursor:"pointer"}}>
              + 작업 추가
            </button>
          </div>
        </div>
      )}

      {/* ── 타이머 ── */}
      {tab==="timer"&&(
        <div>
          {!session?(
            <div style={{textAlign:"center",marginTop:40}}>
              <p style={{fontSize:14,color:"#666"}}>작업 목록에서 작업을 선택해 시작하세요.</p>
              <button onClick={()=>setTab("tasks")} style={{marginTop:12,padding:"8px 24px",fontSize:13,background:"#534AB7",color:"#fff",border:"none",borderRadius:8,cursor:"pointer"}}>작업 목록으로</button>
            </div>
          ):(()=>{
            const g=getGrp(groups,session.gid);
            const cond=conds.find(c=>c.id===session.cid);
            const tObj=tasks.find(t=>t.id===session.tid);
            return(
              <div>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                  <div><span style={{fontSize:18,fontWeight:600}}>{now.getMonth()+1}월 {now.getDate()}일</span><span style={{fontSize:13,color:"#888",marginLeft:6}}>({WDAYS[now.getDay()]})</span></div>
                  <span style={{fontSize:11,padding:"3px 10px",background:g.bg,color:g.color,borderRadius:20}}>{g.label}</span>
                </div>
                <p style={{fontSize:15,fontWeight:500,textAlign:"center",marginBottom:6}}>{session.name}</p>
                {tObj&&(tObj.goalL||tObj.goalS||tObj.quote)&&(
                  <div style={{borderRadius:8,marginBottom:14,overflow:"hidden",border:`1px solid ${tColor}30`}}>
                    {(tObj.goalL||tObj.goalS)&&(
                      <div style={{background:tColor,padding:"10px 14px"}}>
                        {tObj.goalL&&<p style={{fontSize:15,fontWeight:600,color:"#fff",margin:"0 0 2px"}}>{tObj.goalL}</p>}
                        {tObj.goalS&&<p style={{fontSize:12,color:"rgba(255,255,255,.85)",margin:0}}>{tObj.goalS}</p>}
                      </div>
                    )}
                    {tObj.quote&&<p style={{fontSize:12,color:"#666",margin:0,fontStyle:"italic",padding:"8px 14px",background:"#f7f6f3"}}>{tObj.quote}</p>}
                  </div>
                )}
                <div style={{display:"flex",gap:12,alignItems:"flex-start"}}>
                  <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center"}}>
                    <p style={{fontSize:12,color:tColor,fontWeight:500,marginBottom:8}}>{PH_LABEL[session.phase]} · {session.done}/{session.total}</p>
                    <svg width={192} height={192} viewBox="0 0 192 192">
                      <circle cx={96} cy={96} r={78} fill="none" stroke="#e0ddd8" strokeWidth={9}/>
                      <path d={arcPath(pct)} fill="none" stroke={tColor} strokeWidth={9} strokeLinecap="round"/>
                      <text x={96} y={88} textAnchor="middle" fontSize={30} fontWeight={600} fill={tColor} fontFamily="system-ui">{fmtT(tLeft)}</text>
                      <text x={96} y={110} textAnchor="middle" fontSize={11} fill="#888" fontFamily="system-ui">{PH_LABEL[session.phase]}</text>
                    </svg>
                    {!running&&pSec>0&&<p style={{marginTop:8,padding:"4px 12px",background:"#f5f4f0",borderRadius:20,fontSize:12,color:"#888"}}>일시정지 {fmtT(pSec)}</p>}
                    <div style={{display:"flex",gap:8,marginTop:12}}>
                      <button onClick={toggleRun} style={{padding:"9px 24px",fontSize:14,background:tColor,color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontWeight:500}}>{running?"일시정지":"시작"}</button>
                      <button onClick={resetTmr} style={{padding:"9px 14px",fontSize:13,background:"transparent",color:"#666",border:"1px solid #d8d5cf",borderRadius:8,cursor:"pointer"}}>리셋</button>
                      <button onClick={stopSes} style={{padding:"9px 14px",fontSize:13,background:"transparent",color:"#E24B4A",border:"1px solid #E24B4A50",borderRadius:8,cursor:"pointer"}}>종료</button>
                    </div>
                    <div style={{display:"flex",gap:4,marginTop:12,flexWrap:"wrap",justifyContent:"center",maxWidth:192}}>
                      {Array.from({length:session.total}).map((_,i)=>(
                        <div key={i} style={{width:8,height:8,borderRadius:"50%",background:i<session.done?tColor:"#eee",border:i===session.done&&session.phase===FOCUS?`2px solid ${tColor}`:"none"}}/>
                      ))}
                    </div>
                  </div>
                  <div style={{width:110,flexShrink:0}}>
                    <p style={{fontSize:9,color:"#aaa",marginBottom:4,textAlign:"center"}}>전체 흐름</p>
                    <div style={{display:"flex",gap:4}}>
                      <div style={{flex:1}}>
                        <p style={{fontSize:8,color:"#aaa",marginBottom:3,textAlign:"center"}}>설계</p>
                        {tl.map((b,i)=>{const h=b.min*PPM;const col=b.type===FOCUS?PH_COLOR.focus:b.type===LONG?PH_COLOR.long:PH_COLOR.short;const bg2=b.type===FOCUS?PH_BG.focus:b.type===LONG?PH_BG.long:PH_BG.short;return<div key={i} style={{height:h,marginBottom:2,background:bg2,border:`1px solid ${col}`,borderRadius:2,display:"flex",alignItems:"center",justifyContent:"center"}}>{h>14&&<span style={{fontSize:7,color:col}}>{b.min}분</span>}</div>;})}
                      </div>
                      <div style={{flex:1}}>
                        <p style={{fontSize:8,color:"#aaa",marginBottom:3,textAlign:"center"}}>진행</p>
                        <div style={{borderRadius:3,overflow:"hidden",border:aSegs.length>0?"1px solid #d8d5cf":"none"}}>
                          {aSegs.map((seg,i)=>seg.color==="transparent"?<div key={i} style={{height:seg.px,background:"#fff"}}/>:<div key={i} style={{height:Math.max(0,seg.px),background:seg.color}}/>)}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* ── 분석 리포트 ── */}
      {tab==="report"&&(
        <div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:20}}>
            {[{label:"총 집중",value:focMin+"분"},{label:"완료 세션",value:log.length+"회"},{label:"완료 작업",value:tasks.filter(t=>t.done).length+"개"}].map(c=>(
              <div key={c.label} style={{background:"#f7f6f3",borderRadius:8,padding:"12px 10px",textAlign:"center"}}>
                <p style={{fontSize:11,color:"#888",margin:"0 0 4px"}}>{c.label}</p>
                <p style={{fontSize:20,fontWeight:500,margin:0}}>{c.value}</p>
              </div>
            ))}
          </div>
          {log.length===0&&<p style={{fontSize:13,color:"#aaa",textAlign:"center",marginTop:24}}>아직 완료된 세션이 없습니다.</p>}
          {log.length>0&&(
            <div style={{background:"#fff",border:"1px solid #e0ddd8",borderRadius:12,padding:"1rem"}}>
              <p style={{fontSize:13,fontWeight:500,marginBottom:10,color:"#555"}}>세션 기록</p>
              {[...log].reverse().map((l,i)=>{
                const g=getGrp(groups,l.gid);
                return(
                  <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 0",borderBottom:i<log.length-1?"1px solid #f0ede8":"none"}}>
                    <span style={{fontSize:12,flex:1}}>{l.name} <span style={{color:"#aaa"}}>#{l.num}</span></span>
                    <span style={{fontSize:11,color:"#888"}}>{l.min}분 · {l.time}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {confirmModal&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.4)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>setConfirmModal(null)}>
          <div style={{background:"#fff",borderRadius:14,padding:"20px",width:"min(320px,86vw)",boxShadow:"0 10px 40px rgba(0,0,0,.2)"}} onClick={e=>e.stopPropagation()}>
            <p style={{fontSize:14,color:"#333",lineHeight:1.5,margin:"0 0 18px"}}>{confirmModal.message}</p>
            <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
              <button onClick={()=>setConfirmModal(null)} style={{padding:"9px 16px",fontSize:13,background:"transparent",color:"#666",border:"1px solid #d8d5cf",borderRadius:8,cursor:"pointer"}}>취소</button>
              <button onClick={()=>{const fn=confirmModal.onConfirm;setConfirmModal(null);fn&&fn();}} style={{padding:"9px 16px",fontSize:13,background:"#E24B4A",color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontWeight:500}}>확인</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
