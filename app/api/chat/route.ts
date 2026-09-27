import OpenAI from"openai";import{NextResponse}from"next/server";import{supabase}from"../../../lib/supabase";

const system=`You are Tourplus AI Reservation & Sales Assistant. V1 supports Airport Transfer and Malaysia 12-seat Executive Business Coaster. Be concise, warm and professional. Collect trip date, pax, pickup, destination, duration/itinerary; for airport transfers also flight number and luggage when relevant. NEVER invent prices or availability.

OFFICIAL TRAVEL-AGENCY CONTRACT RATES (MYR):
- 8 hours / 100 km: RM1,800
- 10 hours Kuala Lumpur city use: RM2,500
- 10 hours Kuala Lumpur outstation/interstate use: RM3,500
- Kuala Lumpur airport transfer + 5 hours vehicle use: RM2,500
- Kuala Lumpur airport transfer: RM1,500 per trip
- Overtime: RM250/hour
- Extra mileage: RM5/km
- Malaysian driver included
- Chinese-speaking driver: +RM300/day
- Parking fees and driver's meals are excluded.

VEHICLE CONFIGURATION: 12 extra-wide genuine leather seats, business-seat headrests, meeting table, wireless charging, 220V power sockets, refrigerator, thermal flask, independent air-conditioning, ambient lighting, and custom umbrellas.

Only quote when the request clearly matches an approved package. State relevant exclusions when quoting. For unusual/multi-day trips, negotiations, or availability, escalate to a reservation specialist. Never claim availability, payment, or booking confirmation. Do not use Markdown symbols such as ** in customer-facing replies.`;

async function saveLead(client:OpenAI,messages:any[],reply:string,leadId?:string){
 try{
  const x=await client.chat.completions.create({model:process.env.OPENAI_MODEL||"gpt-5.6-luna",response_format:{type:"json_object"},messages:[
   {role:"system",content:`Extract the sales lead from the conversation. Return JSON only with: service ("coaster","airport_transfer","other"), travel_date (YYYY-MM-DD or null), pax (integer or null), pickup (string or null), destination (string or null), itinerary (string or null), quoted_amount (number or null), status ("NEW","QUALIFYING","QUOTED"), ai_summary (short string), human_takeover (boolean). Use QUOTED only if an actual price was quoted. Use QUALIFYING when service intent is known but required details remain. Current date is 2026-09-28. Do not invent missing data.`},
   {role:"user",content:JSON.stringify({conversation:messages,latest_assistant_reply:reply})}
  ]});
  const lead=JSON.parse(x.choices[0]?.message?.content||"{}");
  lead.updated_at=new Date().toISOString();
  let r:Response;
  if(leadId)r=await supabase(`leads?id=eq.${encodeURIComponent(leadId)}`,{method:"PATCH",body:JSON.stringify(lead)});
  else{lead.source="web_demo";r=await supabase("leads",{method:"POST",body:JSON.stringify(lead)})}
  if(!r.ok)throw new Error(await r.text());
  const rows=await r.json();return leadId||rows?.[0]?.id;
 }catch(e:any){console.error("Lead sync error:",e?.message);return leadId}
}

export async function POST(req:Request){try{
 const{messages=[],leadId}=await req.json();
 if(!process.env.OPENAI_API_KEY)return NextResponse.json({reply:"Demo UI is ready. Add OPENAI_API_KEY to enable live AI replies."});
 const client=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
 const c=await client.chat.completions.create({model:process.env.OPENAI_MODEL||"gpt-5.6-luna",messages:[{role:"system",content:system},...messages.map((m:any)=>({role:m.role==="agent"?"assistant":"user",content:String(m.text)}))]});
 const reply=c.choices[0]?.message?.content||"Our reservation team will assist you.";
 const savedLeadId=await saveLead(client,messages,reply,leadId);
 return NextResponse.json({reply,leadId:savedLeadId});
}catch(e:any){console.error("Tourplus chat API error:",e?.status,e?.code,e?.message);return NextResponse.json({reply:"I’m having trouble processing that right now. Our reservation team can assist you."},{status:500})}}
