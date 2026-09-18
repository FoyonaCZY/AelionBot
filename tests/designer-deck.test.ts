import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync} from 'fflate';
import {designerDeck,DECK_LAYOUTS} from '../electron/core/designer-deck';
import {designerPlaybook,designerPlaybookName} from '../electron/core/designer-playbooks';

test('playbooks cover presentation layouts and website clone',()=>{
 assert.equal(designerPlaybookName('ppt'),'presentation');
 assert.equal(designerPlaybookName('clone'),'clone');
 assert.equal(designerPlaybookName('prototype'),'prototype');
 assert.equal(designerPlaybookName('mobile'),'mobile');
 assert.equal(designerPlaybookName('document'),'document');
 const ppt=designerPlaybook('presentation');
 assert.match(ppt,/agenda/);
 assert.match(ppt,/design_deck/);
 assert.match(ppt,/cta/);
 assert.match(ppt,/Never invent/);
 const clone=designerPlaybook('clone');
 assert.match(clone,/NOTES\.md/);
 assert.match(clone,/web_read/);
 assert.match(clone,/generic hero plus three cards/);
 assert.match(clone,/login, payment/);
 assert.match(clone,/source URL/i);
 const mobile=designerPlaybook('mobile');
 assert.match(mobile,/device frame|phone-first/i);
 const document=designerPlaybook('document');
 assert.match(document,/print CSS/i);
 assert.throws(()=>designerPlaybook('missing'),/未知/);
});

test('deck layouts include agenda and cta with escaped companion HTML',()=>{
 const deck=designerDeck('Quarterly <Review>',[
  {title:'Cover',body:'A clear story',layout:'title',kicker:'Q3'},
  {title:'Agenda',layout:'agenda',items:['Market','Product','Ask']},
  {title:'Why now',left:'Keep',right:'Change',layout:'compare'},
  {title:'A speaker',body:'The quotation itself',layout:'quote'},
  {title:'Steps',layout:'timeline',items:['Discover','Build','Ship']},
  {title:'Users',metric:'—',caption:'Placeholder until measured',layout:'stat'},
  {title:'Next step',body:'Book the review',layout:'cta'},
 ]);
 const zip=unzipSync(deck.pptx);
 assert.ok(zip['ppt/_rels/presentation.xml.rels']);
 assert.equal(Object.keys(zip).filter(name=>/^ppt\/slides\/slide\d+\.xml$/.test(name)).length,7);
 const agenda=Buffer.from(zip['ppt/slides/slide2.xml']).toString();
 assert.match(agenda,/1\. Market/);
 const quote=Buffer.from(zip['ppt/slides/slide4.xml']).toString();
 assert.match(quote,/The quotation itself/);
 const stat=Buffer.from(zip['ppt/slides/slide6.xml']).toString();
 assert.match(stat,/>—</);
 const html=deck.html.toString();
 assert.match(html,/class="agenda"/);
 assert.match(html,/class="magazine"/);
 assert.match(html,/data-design-id="slide-7"/);
 assert.match(html,/class="cta"/);
 assert.match(html,/Quarterly &lt;Review&gt;/);
 assert.match(html,/data-slide-id="slide-7"/);
 assert.ok(DECK_LAYOUTS.includes('agenda')&&DECK_LAYOUTS.includes('cta'));
 assert.throws(()=>designerDeck('Deck',[{title:'Broken',layout:'timeline'}]),/items/);
 assert.throws(()=>designerDeck('Deck',[{title:'Broken',layout:'unknown' as any}]),/布局/);
});
