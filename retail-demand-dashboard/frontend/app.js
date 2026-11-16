const API = (window.API_BASE_URL || "").replace(/\/$/, "");
let selectedHorizon = 7;
let currentForecast = null;
let historyRecords = [];

const fmt = n => Number(n).toLocaleString("en-IN", {maximumFractionDigits: 0});
const $ = id => document.getElementById(id);

async function api(path, options={}) {
  if (!API || API.includes("YOUR-RENDER-SERVICE")) throw new Error("Add your Render API URL in frontend/config.js first.");
  const res = await fetch(API + path, {headers: {"Content-Type":"application/json"}, ...options});
  if (!res.ok) {
    const body = await res.json().catch(()=>({}));
    throw new Error(body.detail || `API error ${res.status}`);
  }
  return res.json();
}

function drawLineChart(canvas, records) {
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width*dpr; canvas.height = rect.height*dpr;
  ctx.scale(dpr,dpr);
  const w=rect.width,h=rect.height,p={l:48,r:12,t:12,b:28};
  ctx.clearRect(0,0,w,h);
  if (!records.length) return;
  const vals=records.map(x=>x.actual_units), min=Math.min(...vals), max=Math.max(...vals);
  const lo=Math.floor(min/500)*500, hi=Math.ceil(max/500)*500 || max+1;
  ctx.font="10px DM Sans"; ctx.fillStyle="#8b97a8"; ctx.strokeStyle="#edf1f6"; ctx.lineWidth=1;
  for(let i=0;i<5;i++){
    const y=p.t+(h-p.t-p.b)*i/4;
    ctx.beginPath();ctx.moveTo(p.l,y);ctx.lineTo(w-p.r,y);ctx.stroke();
    const v=hi-(hi-lo)*i/4;ctx.fillText((v/1000).toFixed(1)+"k",4,y+3);
  }
  const x=i=>p.l+(w-p.l-p.r)*(records.length===1?0:i/(records.length-1));
  const y=v=>p.t+(h-p.t-p.b)*(hi-v)/(hi-lo||1);
  ctx.beginPath();records.forEach((r,i)=>{if(i===0)ctx.moveTo(x(i),y(r.actual_units));else ctx.lineTo(x(i),y(r.actual_units));});
  ctx.strokeStyle="#3478f6";ctx.lineWidth=2.2;ctx.stroke();
  ctx.fillStyle="#3478f6";records.forEach((r,i)=>{if(i%Math.max(1,Math.floor(records.length/12))===0){ctx.beginPath();ctx.arc(x(i),y(r.actual_units),2.5,0,Math.PI*2);ctx.fill();}});
  ctx.fillStyle="#8b97a8";ctx.fillText(records[0].date.slice(5),p.l,h-7);ctx.fillText(records[records.length-1].date.slice(5),w-48,h-7);
}

async function loadHistory() {
  const days = $("history-range").value;
  const data = await api(`/history?days=${days}`);
  historyRecords = data.records;
  drawLineChart($("history-chart"), historyRecords);
  const avg = historyRecords.reduce((s,r)=>s+r.actual_units,0)/historyRecords.length;
  $("avg-demand").textContent = fmt(avg);
  const latest = historyRecords[historyRecords.length-1];
  $("latest-demand").textContent = fmt(latest.actual_units);
  $("latest-date").textContent = `Observed ${latest.date}`;
}

function renderForecast(data) {
  currentForecast = data;
  $("selected-total").textContent = fmt(data.total_predicted_units);
  $("selected-average").textContent = `Average per day ${fmt(data.average_daily_predicted_units)} units`;
  $("selected-model").textContent = data.model;
  $("selected-period").textContent = `${data.forecast_start} → ${data.forecast_end}`;
  $("table-title").textContent = `${data.horizon_days}-day demand forecast`;
  $("forecast-rows").innerHTML = data.predictions.map(p=>{
    const day = new Date(p.date+"T00:00:00").toLocaleDateString("en-IN",{weekday:"short"});
    return `<tr><td>${p.date}</td><td>${day}</td><td>${fmt(p.predicted_units)}</td></tr>`;
  }).join("");
  $("forecast-status").textContent = `Generated from ${data.history_source === "included_dataset_demo" ? "included historical dataset" : "provided history"}.`;
  if(data.horizon_days===7) $("total-7").textContent=fmt(data.total_predicted_units);
  if(data.horizon_days===30) $("total-30").textContent=fmt(data.total_predicted_units);
}

async function generateForecast() {
  const btn=$("generate-btn");btn.disabled=true;btn.textContent="Generating…";
  $("forecast-status").textContent="Requesting predictions from FastAPI…";
  try {
    const horizon=selectedHorizon;
    const data=await api(`/forecast/${horizon}-days`,{method:"POST",body:JSON.stringify({})});
    renderForecast(data);
    if(horizon===7)$("model-7").textContent=data.model;
    else $("model-30").textContent=data.model;
  } catch(e) {
    $("forecast-status").textContent=e.message;
  } finally {btn.disabled=false;btn.innerHTML='Generate forecast <span>→</span>';}
}

function exportCSV() {
  if(!currentForecast){$("forecast-status").textContent="Generate a forecast before exporting.";return;}
  const rows=[["Date","Predicted Units"],...currentForecast.predictions.map(p=>[p.date,p.predicted_units])];
  const csv=rows.map(r=>r.join(",")).join("\n");
  const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));
  a.download=`retail-demand-${currentForecast.horizon_days}-day-forecast.csv`;a.click();URL.revokeObjectURL(a.href);
}

async function init() {
  document.querySelectorAll(".horizon").forEach(btn=>btn.addEventListener("click",()=>{
    document.querySelectorAll(".horizon").forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");selectedHorizon=Number(btn.dataset.horizon);
    if(currentForecast && currentForecast.horizon_days===selectedHorizon) renderForecast(currentForecast);
    else {$("table-title").textContent=`${selectedHorizon}-day demand forecast`;$("selected-total").textContent="—";}
  }));
  $("generate-btn").addEventListener("click",generateForecast);
  $("history-range").addEventListener("change",()=>loadHistory().catch(e=>$("forecast-status").textContent=e.message));
  $("refresh-btn").addEventListener("click",()=>boot());
  $("download-csv").addEventListener("click",exportCSV);
  await boot();
}
async function boot(){
  try{
    const health=await api("/health");
    $("api-status").textContent="Online";
    await loadHistory();
    await generateForecast();
    selectedHorizon=7;
  }catch(e){
    $("api-status").textContent="Offline";
    $("forecast-status").textContent=e.message;
  }
}
window.addEventListener("resize",()=>{if(historyRecords.length)drawLineChart($("history-chart"),historyRecords)});
document.addEventListener("DOMContentLoaded",init);
