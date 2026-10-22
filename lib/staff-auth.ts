import {cookies} from "next/headers";
const base=process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon=process.env.SUPABASE_ANON_KEY;
export async function staffUser(){
 const token=(await cookies()).get("tp_staff_session")?.value;
 if(!token||!base||!anon)return null;
 const res=await fetch(base+"/auth/v1/user",{headers:{apikey:anon,Authorization:"Bearer "+token},cache:"no-store"});
 if(!res.ok)return null;
 const user=await res.json();
 const emails=(process.env.STAFF_EMAILS||"").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
 return user?.email&&emails.includes(String(user.email).toLowerCase())?user:null;
}
export async function staffRequired(){return (await staffUser())!==null;}
