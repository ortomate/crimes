export function discount(plan,cents) { if(plan==="team") return Math.floor(cents*0.10); if(plan==="enterprise") return Math.floor(cents*0.20); return 0; }
