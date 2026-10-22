import {NextResponse} from "next/server";
export async function POST(req:Request){
 const {email,password}=await req.json();
 const base=process.env.NEXT_PUBLIC_SUPABASE_URL,anon=process.env.SUPABASE_ANON_KEY;
 if(!base||!anon||!process.env.STAFF_EMAILS)return NextResponse.json({error:"Staff login is not configured"},{status:503});
 const allowed=process.env.STAFF_EMAILS.split(",").map(s=>s.trim().toLowerCase());
 if(!allowed.includes(String(email||"").toLowerCase()))return NextResponse.json({error:"Invalid credentials"},{status:401});
 const r=await fetch(base+"/auth/v1/token?grant_type=password",{method:"POST",headers:{apikey:anon,"Content-Type":"application/json"},body:JSON.stringify({email,password}),cache:"no-store"});
 if(!r.ok)return NextResponse.json({error:"Invalid credentials"},{status:401});
 const session=await r.json();
 const response=NextResponse.json({ok:true});
 response.cookies.set("tp_staff_session",session.access_token,{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/",maxAge:Math.min(Number(session.expires_in)||3600,3600)});
 return response;
}
