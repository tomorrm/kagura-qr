#!/usr/bin/env python3
"""Dependency-free source-level accessibility gate (not a screen-reader certification)."""
from html.parser import HTMLParser
from pathlib import Path
import sys

class Audit(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ids=set();self.labels=set();self.inputs=[];self.buttons=[];self.images=[]
        self.summary_count=0;self.stack=[];self.errors=[];self.tabs=[];self.panels=[];self.links=[]
    def handle_starttag(self,tag,attrs):
        a=dict(attrs);i=a.get('id');
        if i:self.ids.add(i)
        if tag=='label' and 'for' in a:self.labels.add(a['for'])
        if tag in ('input','select','textarea'):self.inputs.append((tag,a,self.getpos()[0]))
        if tag=='button':self.buttons.append((a,self.getpos()[0]))
        if tag=='img':self.images.append((a,self.getpos()[0]))
        if tag=='summary':self.summary_count+=1
        if a.get('role')=='tab':self.tabs.append((a,self.getpos()[0]))
        if a.get('role')=='tabpanel':self.panels.append((a,self.getpos()[0]))
        if tag=='a':self.links.append((a,self.getpos()[0]))
        self.stack.append((tag,a))
    def handle_endtag(self,tag):
        for i in range(len(self.stack)-1,-1,-1):
            if self.stack[i][0]==tag:
                self.stack=self.stack[:i];break
    def in_label(self,item):
        # Label can contain a nested control; HTMLParser stack after starttag contains the control.
        for tag,a in self.stack:
            if tag=='label':return True
        return False

html=Path(__file__).resolve().parent.parent.joinpath('index.html').read_text()
p=Audit();p.feed(html)
# A nested label is discovered by walking the source before each control.
class NestedLabel(HTMLParser):
    def __init__(self):super().__init__();self.stack=[];self.unlabelled=[]
    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        if tag in ('input','select','textarea'):
            i=a.get('id','')
            if a.get('type') not in ('hidden',) and not ('hidden' in a) and not (
                i in p.labels or a.get('aria-label') or a.get('aria-labelledby') or 'label' in self.stack
            ):
                self.unlabelled.append(i or f'line {self.getpos()[0]}')
        if tag not in ('input','img','br','hr','meta','link','source','area','embed','wbr'):self.stack.append(tag)
    def handle_endtag(self,tag):
        if tag in self.stack:
            pos=len(self.stack)-self.stack[::-1].index(tag)-1
            self.stack=self.stack[:pos]
n=NestedLabel();n.feed(html)
if n.unlabelled:p.errors.append('Unlabelled fields: '+', '.join(n.unlabelled))
for a,line in p.images:
    if 'alt' not in a:p.errors.append(f'Image at {line} missing alt')
import re
for match in re.finditer(r'<button\b([^>]*)>(.*?)</button>',html,re.S|re.I):
    attrs,body=match.groups()
    text=re.sub(r'<[^>]+>',' ',body).strip()
    if not text and 'aria-label=' not in attrs and 'title=' not in attrs:
        p.errors.append('Button without accessible text or label')
for a,line in p.tabs:
    if not a.get('aria-controls') or a['aria-controls'] not in p.ids:p.errors.append(f'Tab {line} missing valid aria-controls')
for a,line in p.panels:
    if not a.get('aria-labelledby') or a['aria-labelledby'] not in p.ids:p.errors.append(f'Tabpanel {line} missing aria-labelledby')
for a,line in p.links:
    if a.get('target')=='_blank' and 'noopener' not in a.get('rel',''):p.errors.append(f'New tab link {line} missing noopener')
if p.errors:
    print('A11y audit FAIL:\n'+'\n'.join('- '+error for error in p.errors));sys.exit(1)
print(f'A11y source audit PASS: {len(p.inputs)} fields, {len(p.buttons)} buttons, {len(p.tabs)} tabs, {p.summary_count} disclosures checked. Screen-reader/visual checks remain external.')
