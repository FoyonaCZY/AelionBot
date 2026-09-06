export const BOT_COLORS=['#268bfa','#8b6bea','#19a887','#ed8c35'];

export function randomBotColor(previous?:string){
  const choices=BOT_COLORS.filter(color=>color!==previous);
  return choices[Math.floor(Math.random()*choices.length)];
}
