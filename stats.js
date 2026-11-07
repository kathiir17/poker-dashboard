// ══════════════ STATS CALCULATIONS ══════════════
// Pure functions: they read data and return numbers, and never touch the page or the database.
// index.html and test.html both load this file (a plain script, so everything here is a global).
//
// Most functions take a list of sessions from selectSessions(), so the same code works for one
// season, a whole chapter, or All time. Each session in that list looks like:
//   {id, seq, name, date:"DD/MM/YYYY", results:[{player, buyin, final}],
//    chapter:1|2, season:<number>, seasonName:"Season 2", t:<day number>, order:<0,1,2…>}

const K=3;   // shrinkage: score = total PnL ÷ (sessions played + K)
const EPS=0.004;   // amounts closer than this (under half a penny) count as equal

// A result's profit or loss, rounded to the penny so float noise (0.1+0.2) never matters
function pnl(r){return Math.round((r.final-r.buyin)*100)/100;}

// "DD/MM/YYYY" → whole days since 1970 (for date order and chart spacing)
function dayNum(date){const [d,m,y]=date.split('/').map(Number);return Math.round(Date.UTC(y,m-1,d)/864e5);}

// Sessions for a selection, oldest first, each tagged with its chapter and season.
//   view: 'era-1' | 'era-2' | 'all'    seasonNumber: a season's number, or -1 for all seasons
// Order: date, then chapter, season, and the order sessions were added (seq).
function selectSessions(data,view,seasonNumber){
  const eras=view==='all'?['era-1','era-2']:[view];
  const out=[];
  eras.forEach(eraId=>{
    const chapter=eraId==='era-1'?1:2;
    data.eras[eraId].seasons.forEach(se=>{
      if(seasonNumber!==-1&&se.number!==seasonNumber)return;
      se.sessions.forEach(s=>out.push({...s,chapter,season:se.number,seasonName:se.name,t:dayNum(s.date)}));
    });
  });
  out.sort((a,b)=>a.t-b.t||a.chapter-b.chapter||a.season-b.season||(a.seq||0)-(b.seq||0));
  out.forEach((s,i)=>s.order=i);
  return out;
}

// Short labels: "C2 S2" and "C2 · S2 · Session 1"
function seasonTag(s){return `C${s.chapter} S${s.season}`;}
function sessionTag(s){return `C${s.chapter} · S${s.season} · ${s.name}`;}

// Per player, sorted by rank (best shrunk average first):
//   {name, rank, n, pnlTot, shrunk, rawAvg, buyin, out, inProfit, topped,
//    best:{pnl, session}, worst:{pnl, session}}
// inProfit = sessions with PnL > 0. topped = sessions where they had the highest PnL
// (everyone tied for the top gets it).
function playerStats(sessions){
  const m={};
  sessions.forEach(s=>{
    const top=Math.max(...s.results.map(pnl));
    s.results.forEach(r=>{
      const p=pnl(r);
      const e=m[r.player]||(m[r.player]={name:r.player,n:0,pnlTot:0,buyin:0,out:0,inProfit:0,topped:0,best:null,worst:null});
      e.n++; e.pnlTot+=p; e.buyin+=r.buyin; e.out+=r.final;
      if(p>EPS)e.inProfit++;
      if(p>=top-EPS)e.topped++;
      if(!e.best||p>e.best.pnl)e.best={pnl:p,session:s};
      if(!e.worst||p<e.worst.pnl)e.worst={pnl:p,session:s};
    });
  });
  const all=Object.values(m);
  all.forEach(e=>{e.pnlTot=Math.round(e.pnlTot*100)/100;e.shrunk=e.pnlTot/(e.n+K);e.rawAvg=e.pnlTot/e.n;});
  all.sort((a,b)=>b.shrunk-a.shrunk||a.name.localeCompare(b.name));
  all.forEach((e,i)=>e.rank=i+1);
  return all;
}

// Running total (cumulative PnL) per player: {name: [{session, total}]}, one point for each
// session they played, in order. The chart draws each line from these points.
function runningTotals(sessions){
  const lines={},sum={};
  sessions.forEach(s=>s.results.forEach(r=>{
    sum[r.player]=Math.round(((sum[r.player]||0)+pnl(r))*100)/100;
    (lines[r.player]||(lines[r.player]=[])).push({session:s,total:sum[r.player]});
  }));
  return lines;
}

// Each player's PnL in every session they played, in order: {name: [{session, pnl}]}
// (the "Per session" chart)
function sessionPnls(sessions){
  const out={};
  sessions.forEach(s=>s.results.forEach(r=>(out[r.player]||(out[r.player]=[])).push({session:s,pnl:pnl(r)})));
  return out;
}

// The working behind one rivals() number: every session players a and b both played, oldest first:
//   [{session, a:{buyin, final, pnl}, b:{buyin, final, pnl}, gap}]   gap = a's PnL − b's PnL
// The average of the gaps is the pair's number in rivals().
function sharedSessions(sessions,a,b){
  const out=[];
  sessions.forEach(s=>{
    const ra=s.results.find(r=>r.player===a),rb=s.results.find(r=>r.player===b);
    if(!ra||!rb)return;
    const A={buyin:ra.buyin,final:ra.final,pnl:pnl(ra)},B={buyin:rb.buyin,final:rb.final,pnl:pnl(rb)};
    out.push({session:s,a:A,b:B,gap:Math.round((A.pnl-B.pnl)*100)/100});
  });
  return out;
}

// Rivals: for each player, every opponent they've shared at least minShared sessions with:
//   {player: [{opp, avg, n}]}, avg = average of (my PnL − their PnL) per shared session,
//   so positive means the player usually beats that opponent. Sorted worst rival first.
function rivals(sessions,minShared=3){
  const acc={};
  sessions.forEach(s=>s.results.forEach(a=>s.results.forEach(b=>{
    if(a.player===b.player)return;
    const row=acc[a.player]||(acc[a.player]={});
    const e=row[b.player]||(row[b.player]={opp:b.player,sum:0,n:0});
    e.sum+=pnl(a)-pnl(b); e.n++;
  })));
  const out={};
  Object.entries(acc).forEach(([p,row])=>{
    const list=Object.values(row).filter(e=>e.n>=minShared).map(e=>({opp:e.opp,avg:e.sum/e.n,n:e.n}));
    if(list.length)out[p]=list.sort((a,b)=>a.avg-b.avg||a.opp.localeCompare(b.opp));
  });
  return out;
}

// Headlines for a selection: best and worst single session (ties: the earliest),
// money in play (total buy-ins), and how many sessions and players.
function headlines(sessions){
  let best=null,worst=null,money=0;const players=new Set();
  sessions.forEach(s=>s.results.forEach(r=>{
    const p=pnl(r);money+=r.buyin;players.add(r.player);
    if(!best||p>best.pnl)best={pnl:p,player:r.player,session:s};
    if(!worst||p<worst.pnl)worst={pnl:p,player:r.player,session:s};
  }));
  return {best,worst,money:Math.round(money*100)/100,sessions:sessions.length,players:players.size};
}
