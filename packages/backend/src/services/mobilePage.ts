// The self-contained mobile page served at GET /m — a phone opens it by scanning
// a project's QR code (which carries ?project=<id>&token=<secret>). It is served
// as one HTML document with inline CSS + JS and pulls in NOTHING external (no CDN,
// no bundle), so it loads instantly on a phone and needs no install. All of its
// API/WebSocket calls reuse the existing token-gated backend.
//
// IMPORTANT: this whole page is a JS template literal below. To keep it free of
// escaping traps, the embedded client script deliberately avoids backticks, ${},
// and backslash escapes (control characters are made with String.fromCharCode and
// ANSI is stripped by a hand-written scanner rather than a regex).
export const MOBILE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>NARUKAMI — Phone</title>
<style>
  :root{
    --bg:#08080a; --bg2:#0d0d11; --bg3:#16161c; --border:#26262f;
    --text:#e8e8ee; --dim:#8a8a97; --accent:#ff2d3c; --accent2:#ff5561;
    --green:#35e08a; --red:#ff3b3b; --yellow:#ffb020;
    --mono:'JetBrains Mono','Fira Code',Consolas,monospace;
  }
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
  html,body{margin:0;height:100%;}
  body{
    background:var(--bg); color:var(--text);
    font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
    font-size:15px; -webkit-font-smoothing:antialiased;
  }
  #app{display:flex;flex-direction:column;height:100vh;height:100dvh;}
  .top{
    display:flex;align-items:center;gap:10px;padding:12px 14px;
    background:linear-gradient(180deg,#101014,#0b0b0e);
    border-bottom:1px solid var(--border);position:sticky;top:0;z-index:5;
    padding-top:calc(12px + env(safe-area-inset-top));
  }
  .top .mark{width:4px;height:18px;border-radius:1px;background:linear-gradient(180deg,var(--accent2),#b00614);box-shadow:0 0 12px rgba(255,45,60,.5);flex:none;}
  .top h1{margin:0;font-family:var(--mono);font-size:14px;letter-spacing:2px;text-transform:uppercase;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .top .back{background:transparent;border:1px solid var(--border);color:var(--dim);border-radius:8px;padding:6px 12px;font-size:14px;}
  .top .back:active{color:var(--text);}
  .sub{padding:6px 14px;color:var(--dim);font-size:12px;font-family:var(--mono);border-bottom:1px solid var(--border);background:var(--bg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .list{flex:1;overflow-y:auto;padding:10px;-webkit-overflow-scrolling:touch;}
  .card{
    display:flex;align-items:center;gap:12px;padding:14px;margin-bottom:10px;
    background:var(--bg2);border:1px solid var(--border);border-left:3px solid var(--border);
    border-radius:12px;
  }
  .card:active{background:var(--bg3);}
  .card .dot{width:11px;height:11px;border-radius:50%;background:var(--dim);flex:none;}
  .card .info{flex:1;min-width:0;}
  .card .name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .card .meta{color:var(--dim);font-size:12px;font-family:var(--mono);margin-top:2px;}
  .badge{font-family:var(--mono);font-size:11px;font-weight:700;letter-spacing:.4px;padding:3px 9px;border-radius:999px;border:1px solid var(--border);white-space:nowrap;flex:none;}
  .run{color:var(--green);border-color:rgba(53,224,138,.4);}
  .run .dot,.dot.run{background:var(--green);box-shadow:0 0 8px var(--green);animation:pulse 1.6s ease-in-out infinite;}
  .done{color:var(--dim);}
  .warn{color:var(--yellow);border-color:rgba(255,176,32,.4);}
  .err{color:var(--red);border-color:rgba(255,59,59,.4);}
  .dot.done{background:var(--dim);} .dot.warn{background:var(--yellow);} .dot.err{background:var(--red);box-shadow:0 0 8px var(--red);}
  @keyframes pulse{0%,100%{opacity:.85;}50%{opacity:1;}}
  .empty{padding:40px 20px;text-align:center;color:var(--dim);font-family:var(--mono);font-size:13px;line-height:1.6;}
  .note{margin:10px;padding:12px 14px;border:1px solid var(--border);border-radius:10px;background:var(--bg2);color:var(--dim);font-size:13px;line-height:1.5;}
  .note b{color:var(--text);}
  /* terminal */
  .term{flex:1;display:flex;flex-direction:column;min-height:0;}
  .termhead{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg2);border-bottom:1px solid var(--border);}
  .termhead .tname{font-family:var(--mono);font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  pre#out{flex:1;margin:0;overflow-y:auto;padding:10px 12px;background:#050506;color:#d8d8de;font-family:var(--mono);font-size:12.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word;-webkit-overflow-scrolling:touch;}
  .bar{display:flex;gap:8px;padding:8px;padding-bottom:calc(8px + env(safe-area-inset-bottom));background:var(--bg2);border-top:1px solid var(--border);}
  .bar input{flex:1;min-width:0;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:11px 12px;font-family:var(--mono);font-size:14px;}
  .bar input:focus{outline:none;border-color:var(--accent);}
  .btn{background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:11px 13px;font-size:14px;font-family:var(--mono);white-space:nowrap;}
  .btn:active{border-color:var(--accent);}
  .btn.k{color:var(--yellow);} .btn.s{color:var(--red);}
  .conn{font-family:var(--mono);font-size:11px;color:var(--dim);}
  .conn.live{color:var(--green);} .conn.dead{color:var(--red);}
</style>
</head>
<body>
<div id="app"></div>
<script>
(function(){
  var qs = new URLSearchParams(location.search);
  var TOKEN = qs.get('token') || '';
  var PROJECT = qs.get('project') || '';
  var BASE = location.origin;
  var app = document.getElementById('app');

  function h(tag, cls, txt){ var e=document.createElement(tag); if(cls)e.className=cls; if(txt!=null)e.textContent=txt; return e; }
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function api(path, opts){
    opts = opts || {};
    opts.headers = Object.assign({'Authorization':'Bearer '+TOKEN,'Content-Type':'application/json'}, opts.headers||{});
    return fetch(BASE+path, opts).then(function(r){
      if(r.status===401||r.status===403){ throw new Error('Not authorized — the token is wrong or phone access is off.'); }
      if(!r.ok){ return r.text().then(function(t){ throw new Error('Request failed ('+r.status+')'); }); }
      return r.status===204 ? null : r.json();
    });
  }

  // ---- ANSI / control-char stripper (no regex, no backslash escapes) ----
  var ESC = 27, BEL = 7, CR = 13, LF = 10, TAB = 9;
  function strip(s){
    var out=''; var i=0, n=s.length;
    while(i<n){
      var c=s.charCodeAt(i);
      if(c===ESC){
        var nx=s.charAt(i+1);
        if(nx==='['){ i+=2; while(i<n){ var cc=s.charCodeAt(i); i++; if(cc>=64&&cc<=126)break; } continue; }
        if(nx===']'){ i+=2; while(i<n){ var oc=s.charCodeAt(i); if(oc===BEL){i++;break;} if(oc===ESC)break; i++; } continue; }
        i+=2; continue;
      }
      if(c===CR){ i++; continue; }
      if(c===TAB||c===LF){ out+=s.charAt(i); i++; continue; }
      if(c<32){ i++; continue; }
      out+=s.charAt(i); i++;
    }
    return out;
  }

  function statusInfo(p){
    if(p.live) return {cls:'run', text:'RUNNING'};
    if(p.status==='killed') return {cls:'warn', text:'STOPPED'};
    if(p.status==='error') return {cls:'err', text:'ERROR'};
    if(p.exitCode==null||p.exitCode===0) return {cls:'done', text:'DONE'+(p.exitCode==null?'':' ('+p.exitCode+')')};
    return {cls:'err', text:'FAILED ('+p.exitCode+')'};
  }

  function kindIcon(k){ return k==='claude'?'\\u2726':k==='shell'?'\\u2328':'\\u25b8'; }

  // ---------------- process list (dashboard) ----------------
  var pollTimer=null, lastLive={};
  function showList(){
    if(pollTimer) clearInterval(pollTimer);
    render();
    pollTimer=setInterval(render, 2500);
    function render(){
      api('/api/projects/'+encodeURIComponent(PROJECT)+'/processes').then(function(d){
        app.innerHTML='';
        var top=h('div','top');
        top.appendChild(h('div','mark'));
        top.appendChild(h('h1',null,'NARUKAMI'));
        var rf=h('button','back','\\u21bb'); rf.onclick=render; top.appendChild(rf);
        app.appendChild(top);
        app.appendChild(h('div','sub', (d.project&&d.project.name?d.project.name:'project')+'  \\u00b7  '+ (d.processes.length) +' process'+(d.processes.length===1?'':'es')));
        var list=h('div','list');
        if(!d.processes.length){ list.appendChild(h('div','empty','No processes yet.\\nStart one from NARUKAMI on your computer\\nand it will appear here.')); }
        d.processes.forEach(function(p){
          var si=statusInfo(p);
          // done notification: was live, now finished
          if(lastLive[p.runId] && !p.live){ try{ if(navigator.vibrate) navigator.vibrate(180);}catch(e){} }
          lastLive[p.runId]=p.live;
          var card=h('div','card'); card.style.borderLeftColor = si.cls==='run'?'var(--green)':si.cls==='err'?'var(--red)':si.cls==='warn'?'var(--yellow)':'var(--border)';
          card.appendChild(h('div','dot '+si.cls));
          var info=h('div','info');
          info.appendChild(h('div','name', kindIcon(p.kind)+'  '+(p.label||p.kind)));
          info.appendChild(h('div','meta', p.kind + (p.startedAt?('  \\u00b7  '+new Date(p.startedAt).toLocaleTimeString()):'')));
          card.appendChild(info);
          card.appendChild(h('span','badge '+si.cls, si.text));
          card.onclick=function(){ openTerm(p); };
          list.appendChild(card);
        });
        app.appendChild(list);
      }).catch(function(e){ fail(e); });
    }
  }

  // ---------------- live terminal ----------------
  function openTerm(p){
    if(pollTimer){ clearInterval(pollTimer); pollTimer=null; }
    app.innerHTML='';
    var top=h('div','top');
    var back=h('button','back','\\u2039 Back'); back.onclick=function(){ try{ws&&ws.close();}catch(e){} showList(); };
    top.appendChild(back);
    top.appendChild(h('h1',null, p.label||p.kind));
    var conn=h('span','conn','connecting'); top.appendChild(conn);
    app.appendChild(top);

    var term=h('div','term');
    var out=h('pre'); out.id='out'; term.appendChild(out);
    var bar=h('div','bar');
    var input=h('input'); input.type='text'; input.autocapitalize='off'; input.autocomplete='off'; input.spellcheck=false; input.placeholder='type a command\\u2026';
    var send=h('button','btn','\\u23ce');
    var ctrlc=h('button','btn k','^C');
    var stop=h('button','btn s','\\u25a0');
    bar.appendChild(input); bar.appendChild(send); bar.appendChild(ctrlc); bar.appendChild(stop);
    term.appendChild(bar);
    app.appendChild(term);

    var buf=''; var MAXLEN=200000;
    function write(chunk){
      buf += strip(chunk);
      if(buf.length>MAXLEN) buf = buf.slice(buf.length-MAXLEN);
      var atBottom = out.scrollTop+out.clientHeight >= out.scrollHeight-40;
      out.textContent=buf;
      if(atBottom) out.scrollTop=out.scrollHeight;
    }

    var ws=null, alive=false;
    function connect(){
      var url = BASE.replace('http','ws') + '/ws/runs/' + encodeURIComponent(p.runId) + '?token=' + encodeURIComponent(TOKEN);
      try{ ws=new WebSocket(url); }catch(e){ conn.textContent='error'; conn.className='conn dead'; return; }
      ws.onopen=function(){ alive=true; conn.textContent='live'; conn.className='conn live';
        // rough terminal size for the pty so TUIs wrap sensibly
        var cols=Math.max(20,Math.floor(window.innerWidth/8)); var rows=Math.max(10,Math.floor((window.innerHeight-140)/17));
        try{ ws.send(JSON.stringify({type:'resize',cols:cols,rows:rows})); }catch(e){}
      };
      ws.onmessage=function(ev){
        var m; try{ m=JSON.parse(ev.data); }catch(e){ return; }
        if(m.type==='data'){ write(m.chunk||''); }
        else if(m.type==='exit'){
          alive=false;
          var code=(m.exitCode==null?'':' ('+m.exitCode+')');
          var ok=(m.status==='exited'&&(m.exitCode==null||m.exitCode===0));
          conn.textContent=(m.status==='killed'?'stopped':ok?'done'+code:'ended'+code);
          conn.className='conn '+(ok?'live':'dead');
          write('\\n\\u2014\\u2014 process '+(m.status||'ended')+code+' \\u2014\\u2014\\n');
          input.disabled=true; send.disabled=true;
          try{ if(navigator.vibrate) navigator.vibrate(180); }catch(e){}
        } else if(m.type==='error'){ conn.textContent='error'; conn.className='conn dead'; write('\\n[ '+(m.message||'error')+' ]\\n'); }
      };
      ws.onclose=function(){ if(alive){ conn.textContent='closed'; conn.className='conn dead'; alive=false; } };
      ws.onerror=function(){ conn.textContent='error'; conn.className='conn dead'; };
    }
    connect();

    function submit(){
      var v=input.value; if(!alive) return;
      try{ ws.send(JSON.stringify({type:'input', data: v + String.fromCharCode(13)})); }catch(e){}
      input.value='';
    }
    send.onclick=submit;
    input.addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); submit(); } });
    ctrlc.onclick=function(){ if(alive){ try{ ws.send(JSON.stringify({type:'input', data:String.fromCharCode(3)})); }catch(e){} } };
    stop.onclick=function(){ api('/api/runs/'+encodeURIComponent(p.runId)+'/stop',{method:'POST'}).catch(function(){}); };
  }

  // ---------------- project picker (when no ?project given) ----------------
  function showProjects(){
    api('/api/projects').then(function(list){
      app.innerHTML='';
      var top=h('div','top'); top.appendChild(h('div','mark')); top.appendChild(h('h1',null,'NARUKAMI')); app.appendChild(top);
      app.appendChild(h('div','sub','Pick a project'));
      var l=h('div','list');
      if(!list.length) l.appendChild(h('div','empty','No projects yet.'));
      list.forEach(function(pr){
        var card=h('div','card');
        var info=h('div','info');
        info.appendChild(h('div','name', pr.name));
        info.appendChild(h('div','meta', pr.path||''));
        card.appendChild(info);
        card.appendChild(h('span','badge','open'));
        card.onclick=function(){ PROJECT=pr.id; showList(); };
        l.appendChild(card);
      });
      app.appendChild(l);
    }).catch(function(e){ fail(e); });
  }

  function fail(e){
    app.innerHTML='';
    var top=h('div','top'); top.appendChild(h('div','mark')); top.appendChild(h('h1',null,'NARUKAMI')); app.appendChild(top);
    app.appendChild(h('div','note', (e&&e.message)||'Something went wrong.'));
    app.appendChild(h('div','note','Make sure your phone is on the same Wi\\u2011Fi as your computer and that Phone access is turned on in NARUKAMI.'));
  }

  if(!TOKEN){ fail(new Error('Missing access token. Scan the QR code from NARUKAMI again.')); }
  else if(PROJECT){ showList(); }
  else { showProjects(); }
})();
</script>
</body>
</html>`;
