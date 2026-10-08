/**
 * Realistic Live UI replies for the dev gallery: each one is a whole assistant
 * message (prose around one ```live-ui fence), written the way the prompt
 * contract asks a model to write them.
 */

export interface LiveUISample {
  id: string;
  label: string;
  prompt: string;
  reply: string;
}

const fence = (json: string) => "```live-ui\n" + json.trim() + "\n```";

export const LIVE_UI_SAMPLES: LiveUISample[] = [
  {
    id: "bill",
    label: "Bill splitter from a receipt",
    prompt: "Here's the receipt from Trattoria Moro, there were 4 of us. How much does everyone owe with a 10% tip?",
    reply: `With a 10% tip the bill comes to **€148.99**, so each of the four of you owes **€37.25**.

${fence(`
{"title":"Trattoria Moro, split evenly","currency":"EUR",
 "data":{"items":[{"item":"Burrata","price":14},{"item":"Cacio e pepe","price":16.5},{"item":"Pizza diavola","price":15},{"item":"Branzino","price":27},{"item":"Tiramisu (2)","price":18},{"item":"Etna Rosso, bottle","price":38},{"item":"Sparkling water","price":6.95}]},
 "let":{"subtotal":"sum(items.price)","service":"subtotal * tip","total":"subtotal + service","each":"total / people","roundUp":"ceil(each)"},
 "ui":[
  {"type":"row","children":[
   {"type":"slider","id":"tip","label":"Tip","min":0,"max":0.25,"step":0.01,"value":0.1,"format":"percent"},
   {"type":"stepper","id":"people","label":"People","min":1,"max":12,"value":4}]},
  {"type":"row","children":[
   {"type":"metric","label":"Each person pays","value":"each","format":"currency","emphasis":true,"hint":"Round up to {{fmt(roundUp,'currency',0)}} and the table leaves {{fmt(roundUp * people - total,'currency')}} extra"},
   {"type":"metric","label":"Total with tip","value":"total","format":"currency","hint":"{{fmt(service,'currency')}} of it is tip"}]},
  {"type":"table","rows":"items","columns":[{"label":"Item","value":"item"},{"label":"Price","value":"price","format":"currency"},{"label":"Each, with tip","value":"price * (1 + tip) / people","format":"currency"}]},
  {"type":"row","children":[
   {"type":"button","label":"Split by who ordered what","prompt":"Split the Trattoria Moro receipt by who ordered what instead of evenly, keeping a {{fmt(tip,'percent',0)}} tip."},
   {"type":"button","label":"Copy each share","copy":"fmt(each,'currency')"}]}]}
`)}

Italy doesn't expect a tip on top of the *coperto*, so 5% or rounding up is also perfectly normal there.`,
  },
  {
    id: "retirement",
    label: "Retirement savings calculator with chart",
    prompt: "I'm 32 with €25k saved. If I put away €600 a month, what will I have at 65?",
    reply: `At a 6% average yearly return you'd reach roughly **€925,000** by 65, about three and a half times the €262,600 you put in. Move the sliders to see how much the contribution and the return matter.

${fence(`
{"title":"Savings at retirement","currency":"EUR",
 "let":{"years":"retire - age","balance":"fv(rate / 12, years * 12, monthly, start)","paidIn":"start + monthly * 12 * years","growth":"balance - paidIn","income":"balance * 0.04 / 12"},
 "ui":[
  {"type":"grid","columns":2,"children":[
   {"type":"stepper","id":"age","label":"Age today","min":18,"max":70,"value":32},
   {"type":"slider","id":"retire","label":"Retire at","min":50,"max":75,"step":1,"value":65},
   {"type":"slider","id":"monthly","label":"Monthly saving","min":0,"max":3000,"step":50,"value":600,"format":"currency"},
   {"type":"slider","id":"rate","label":"Yearly return","min":0.01,"max":0.1,"step":0.005,"value":0.06,"format":"percent"}]},
  {"type":"number","id":"start","label":"Saved so far","value":25000,"min":0,"step":1000,"format":"currency"},
  {"type":"row","children":[
   {"type":"metric","label":"Balance at {{retire}}","value":"balance","format":"currency","emphasis":true,"hint":"{{fmt(growth,'currency',0)}} of it is growth"},
   {"type":"metric","label":"Monthly income at 4%","value":"income","format":"currency","hint":"The 4% rule, before tax"}]},
  {"type":"chart","kind":"area","title":"Balance by year","x":{"from":0,"to":"years","step":1,"var":"year","label":"Year"},"format":"currency",
   "series":[{"label":"Balance","y":"fv(rate / 12, year * 12, monthly, start)"},{"label":"Paid in","y":"start + monthly * 12 * year"}]},
  {"type":"text","tone":"muted","text":"Assumes a steady {{fmt(rate,'percent')}} return compounded monthly, in today's euros before inflation, fees and tax."}]}
`)}

Two things move this most: starting earlier and the return you actually get after fees. A 1% fee is roughly the difference between 6% and 5% here.`,
  },
  {
    id: "bike",
    label: "Bike parts explorer",
    prompt: "Explain the main parts of a road bike and what each one does.",
    reply: `A road bike is a light frame with a handful of systems hung off it: two wheels, a drivetrain that turns your legs into speed, brakes, and the three contact points where you touch the bike. Tap a part to see what it does.

${fence(`
{"title":"Road bike, part by part",
 "ui":[
  {"type":"explorer","parts":[
   {"id":"frame","label":"Frame","at":[50,46],"summary":"The skeleton everything bolts to","detail":"Usually carbon fibre or aluminium. Its geometry (the angles and tube lengths) decides whether the bike feels racy and stretched or upright and stable.","facts":[{"label":"Typical weight","value":"0.8 to 1.5 kg"},{"label":"Main tubes","value":"Top, down, seat"}]},
   {"id":"fork","label":"Fork","at":[71,44],"summary":"Holds the front wheel and steers","detail":"The fork's rake and the head-tube angle set the trail, which is what makes a bike feel twitchy or calm at speed.","facts":[{"label":"Material","value":"Usually carbon"}]},
   {"id":"front","label":"Front wheel","at":[82,70],"summary":"Rolls, steers, carries 40% of your weight","detail":"Deeper rims are faster in a straight line but catch crosswinds. Tyre width (25 to 32 mm today) matters more for comfort than almost anything else.","facts":[{"label":"Tyre pressure","value":"4 to 6 bar"}]},
   {"id":"rear","label":"Rear wheel","at":[18,70],"summary":"Takes the drive from the chain","detail":"Carries the cassette (the stack of rear cogs) on a freehub that lets you coast without pedalling.","facts":[{"label":"Cogs","value":"11 to 13"}]},
   {"id":"drivetrain","label":"Drivetrain","at":[44,74],"summary":"Turns pedalling into speed","detail":"Cranks, chainrings, chain, cassette and derailleurs. Shifting moves the chain between cogs so you can keep a comfortable cadence on climbs and descents.","facts":[{"label":"Gears","value":"22 to 26"},{"label":"Efficiency","value":"About 97%"}]},
   {"id":"brakes","label":"Brakes","at":[92,40],"summary":"Disc or rim, front does most of the work","detail":"Most new road bikes use hydraulic disc brakes: more power in the wet and no rim wear. The front brake provides around 70% of stopping force.","facts":[{"label":"Rotor size","value":"140 or 160 mm"}]},
   {"id":"saddle","label":"Saddle","at":[34,12],"summary":"Contact point one","detail":"Height is the single most important fit setting: with the pedal at the bottom your knee should stay slightly bent."},
   {"id":"bars","label":"Handlebar","at":[70,14],"summary":"Contact point two, and the controls","detail":"Drop bars give three hand positions; the brake levers double as shifters."}],
   "links":[["frame","fork"],["fork","front"],["frame","rear"],["frame","saddle"],["fork","bars"],["frame","drivetrain"],["drivetrain","rear"],["brakes","front"],["brakes","bars"]]},
  {"type":"button","label":"Which parts are worth upgrading first?","prompt":"On a road bike, which parts are worth upgrading first, and roughly what does each cost?"}]}
`)}

If you're choosing a bike, fit and tyres matter more to how it feels than the groupset tier.`,
  },
  {
    id: "trip",
    label: "Trip plan with stops",
    prompt: "Plan a relaxed Saturday in Lisbon, mostly on foot, starting from Baixa.",
    reply: `Here's an easy loop: Baixa to Alfama in the morning, lunch by the river, and sunset in Bairro Alto. It's about 7 km of walking with one tram ride to save your legs on the hill.

${fence(`
{"title":"A slow Saturday in Lisbon",
 "ui":[
  {"type":"stops","stops":[
   {"name":"Praça do Comércio","time":"9:30","note":"Coffee and a pastel de nata at Confeitaria Nacional on the way","query":"Praça do Comércio, Lisbon"},
   {"name":"Tram 28 to Graça","time":"10:15","note":"Board at Martim Moniz to get a seat; 25 minutes","query":"Martim Moniz, Lisbon"},
   {"name":"Miradouro da Senhora do Monte","time":"10:45","note":"The best view over the castle and the river","query":"Miradouro da Senhora do Monte, Lisbon"},
   {"name":"Alfama and the Sé","time":"11:30","note":"Walk downhill through the lanes to the cathedral","query":"Sé de Lisboa"},
   {"name":"Lunch at Time Out Market","time":"13:30","note":"Busy but quick; go upstairs for a table","query":"Time Out Market Lisboa"},
   {"name":"LX Factory","time":"15:30","note":"Bookshop Ler Devagar, then coffee","query":"LX Factory, Lisbon"},
   {"name":"Miradouro de Santa Catarina","time":"18:45","note":"Sunset, then dinner in Bairro Alto","query":"Miradouro de Santa Catarina, Lisbon"}]},
  {"type":"checklist","id":"pack","title":"Before you go","items":["Comfortable shoes with grip (the cobbles are slippery)","A Viva Viagem card loaded for the tram",{"label":"Book dinner","note":"Bairro Alto fills up after 20:00 on Saturdays"},"Water and sunscreen"]},
  {"type":"button","label":"Make a rainy-day version","prompt":"Make a rainy-day version of this Lisbon Saturday, mostly indoors."}]}
`)}

If you'd rather skip the tram, the walk up to Graça is steep but only 20 minutes.`,
  },
  {
    id: "stats",
    label: "Statistics demo: the normal distribution",
    prompt: "Help me understand what standard deviation does to a normal distribution.",
    reply: `The standard deviation sets how spread out the values are: a small one gives a tall, narrow bell and a large one a low, wide bell. The area under the curve always stays 1, which is why widening it must also flatten it. Try it:

${fence(`
{"title":"The normal distribution",
 "let":{"p":"normcdf(cutoff, mean, sd)","z":"(cutoff - mean) / sd"},
 "ui":[
  {"type":"grid","columns":3,"children":[
   {"type":"slider","id":"mean","label":"Mean (μ)","min":-3,"max":3,"step":0.1,"value":0},
   {"type":"slider","id":"sd","label":"Standard deviation (σ)","min":0.3,"max":3,"step":0.1,"value":1},
   {"type":"slider","id":"cutoff","label":"Cutoff x","min":-4,"max":4,"step":0.1,"value":1}]},
  {"type":"chart","kind":"area","x":{"from":-5,"to":5,"step":0.1,"var":"x","label":"x ="},"mark":"cutoff",
   "series":[{"label":"Your curve","y":"normpdf(x, mean, sd)"},{"label":"Standard normal","y":"normpdf(x, 0, 1)"}]},
  {"type":"row","children":[
   {"type":"metric","label":"Share below the cutoff","value":"p","format":"percent","emphasis":true},
   {"type":"metric","label":"z-score","value":"round(z, 2)"},
   {"type":"metric","label":"Peak height","value":"normpdf(mean, mean, sd)","format":"number"}]},
  {"type":"text","text":"About **{{fmt(p,'percent')}}** of values fall below {{cutoff}}, which is {{round(abs(z), 2)}} σ {{z >= 0 ? 'above' : 'below'}} the mean."}]}
`)}

The rule of thumb to remember: about 68% of values sit within one σ of the mean, 95% within two and 99.7% within three.`,
  },
];
