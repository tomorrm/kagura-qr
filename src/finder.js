const MAX_EDGE=960;
const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);

function hull(points) {
  points.sort((a,b)=>a.x-b.x||a.y-b.y);
  const half=[];
  for(const p of points){
    while(half.length>1&&cross(half.at(-2),half.at(-1),p)<=0)half.pop();
    half.push(p);
  }
  const lower=half.length;
  for(let i=points.length-2;i>=0;i--){
    const p=points[i];
    while(half.length>lower&&cross(half.at(-2),half.at(-1),p)<=0)half.pop();
    half.push(p);
  }
  half.pop();
  while(half.length>4){
    let smallest=Infinity,index=0;
    for(let i=0;i<half.length;i++){
      const area=Math.abs(cross(half[(i+half.length-1)%half.length],half[i],half[(i+1)%half.length]));
      if(area<smallest){smallest=area;index=i;}
    }
    half.splice(index,1);
  }
  return half;
}

function solve(matrix) {
  for(let col=0;col<8;col++){
    let pivot=col;
    for(let row=col+1;row<8;row++)if(Math.abs(matrix[row][col])>Math.abs(matrix[pivot][col]))pivot=row;
    if(Math.abs(matrix[pivot][col])<1e-10)return null;
    [matrix[col],matrix[pivot]]=[matrix[pivot],matrix[col]];
    const divisor=matrix[col][col];
    for(let j=col;j<=8;j++)matrix[col][j]/=divisor;
    for(let row=0;row<8;row++)if(row!==col){
      const factor=matrix[row][col];
      for(let j=col;j<=8;j++)matrix[row][j]-=factor*matrix[col][j];
    }
  }
  return matrix.map(row=>row[8]);
}

function fit(pairs) {
  const normal=Array.from({length:8},()=>Array(9).fill(0));
  for(const [u,v,x,y] of pairs){
    for(const row of [[u,v,1,0,0,0,-u*x,-v*x,x],[0,0,0,u,v,1,-u*y,-v*y,y]]){
      for(let i=0;i<8;i++)for(let j=0;j<=8;j++)normal[i][j]+=row[i]*row[j];
    }
  }
  const h=solve(normal);
  if(!h)return null;
  return (u,v)=>{
    const w=h[6]*u+h[7]*v+1;
    return {x:(h[0]*u+h[1]*v+h[2])/w,y:(h[3]*u+h[4]*v+h[5])/w};
  };
}

function quadrilateralMap(quad) {
  return fit(quad.map((p,i)=>[[0,0],[1,0],[1,1],[0,1]][i].concat(p.x,p.y)));
}

function refineQuad(quad,boundary) {
  const center={x:quad.reduce((sum,p)=>sum+p.x,0)/4,y:quad.reduce((sum,p)=>sum+p.y,0)/4};
  const lines=quad.map((a,i)=>{
    const b=quad[(i+1)%4],dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
    const selected=boundary.filter(p=>{
      const projection=((p.x-a.x)*dx+(p.y-a.y)*dy)/(length*length);
      return projection>.15&&projection<.85&&Math.abs(cross(a,b,p))/length<1.5;
    });
    if(selected.length<4)return null;
    const x=selected.reduce((sum,p)=>sum+p.x,0)/selected.length;
    const y=selected.reduce((sum,p)=>sum+p.y,0)/selected.length;
    let xx=0,xy=0,yy=0;
    for(const p of selected){xx+=(p.x-x)**2;xy+=(p.x-x)*(p.y-y);yy+=(p.y-y)**2;}
    const angle=.5*Math.atan2(2*xy,xx-yy);
    let nx=-Math.sin(angle),ny=Math.cos(angle);
    if(nx*(center.x-x)+ny*(center.y-y)>0){nx=-nx;ny=-ny;}
    return {nx,ny,c:nx*x+ny*y+.5};
  });
  if(lines.some(line=>!line))return quad;
  return lines.map((b,i)=>{
    const a=lines[(i+3)%4],den=a.nx*b.ny-b.nx*a.ny;
    if(Math.abs(den)<1e-5)return quad[i];
    return {x:(a.c*b.ny-b.c*a.ny)/den,y:(a.nx*b.c-b.nx*a.c)/den};
  });
}

function finderPatterns(binary,width,height) {
  const visited=new Uint8Array(binary.length),queue=new Uint32Array(binary.length);
  const patterns=[];
  for(let start=0;start<binary.length;start++){
    if(!binary[start]||visited[start])continue;
    let head=0,tail=1;queue[0]=start;visited[start]=1;
    let left=width,right=0,top=height,bottom=0;
    const boundary=[];
    while(head<tail){
      const index=queue[head++],x=index%width,y=Math.floor(index/width);
      left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
      let edge=false;
      for(const next of [x>0?index-1:-1,x+1<width?index+1:-1,y>0?index-width:-1,y+1<height?index+width:-1]){
        if(next<0||!binary[next]){edge=true;continue;}
        if(!visited[next]){visited[next]=1;queue[tail++]=next;}
      }
      if(edge&&boundary.length<20000)boundary.push({x,y});
    }
    const w=right-left+1,h=bottom-top+1;
    if(tail<40||w<14||h<14||w/h<.25||w/h>4||tail/(w*h)>.8||boundary.length>=20000)continue;
    const quad=hull(boundary);
    if(quad.length!==4)continue;
    const map=quadrilateralMap(quad);
    if(!map)continue;
    let correct=0;
    for(let y=0;y<7;y++)for(let x=0;x<7;x++){
      const p=map((x+.5)/7,(y+.5)/7);
      const px=Math.round(p.x),py=Math.round(p.y);
      const dark=x===0||x===6||y===0||y===6||(x>=2&&x<=4&&y>=2&&y<=4);
      if(px>=0&&py>=0&&px<width&&py<height&&Boolean(binary[py*width+px])===dark)correct++;
    }
    if(correct<47)continue;
    const center=map(.5,.5);
    const expanded=refineQuad(quad,boundary);
    patterns.push({quad:expanded,center,score:correct,module:Math.sqrt(w*h)/7});
  }
  return patterns.sort((a,b)=>b.score-a.score||b.module-a.module).slice(0,12);
}

function orient(quad,origin,horizontal,vertical) {
  const angle=Math.atan2(horizontal.y-origin.y,horizontal.x-origin.x);
  const cos=Math.cos(angle),sin=Math.sin(angle);
  const flip=cross(origin,horizontal,vertical)>0?1:-1;
  const local=quad.map(p=>({p,x:(p.x-origin.x)*cos+(p.y-origin.y)*sin,
    y:flip*(-(p.x-origin.x)*sin+(p.y-origin.y)*cos)}));
  const first=local.reduce((best,p,i)=>p.x+p.y<local[best].x+local[best].y?i:best,0);
  const ordered=Array.from({length:4},(_,i)=>quad[(first+i)%4]);
  if(cross(ordered[0],ordered[1],ordered[2])*flip<0)return [ordered[0],ordered[3],ordered[2],ordered[1]];
  return ordered;
}

/** Locate nested 7x7 finder rings without decoding or inventing QR content. */
export function findQRCorners(rgba,width,height) {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||
      width>MAX_EDGE||height>MAX_EDGE||!(rgba instanceof Uint8ClampedArray)||rgba.length!==width*height*4)
    throw new Error('四隅検出の画像サイズが不正です。');
  const gray=new Uint8Array(width*height),hist=new Uint32Array(256);
  let sum=0;
  for(let i=0;i<gray.length;i++){
    gray[i]=Math.round((rgba[i*4]*.299+rgba[i*4+1]*.587+rgba[i*4+2]*.114)*rgba[i*4+3]/255+
      255*(1-rgba[i*4+3]/255));
    hist[gray[i]]++;sum+=gray[i];
  }
  let weight=0,partial=0,best=-1,threshold=128;
  for(let i=0;i<255;i++){
    weight+=hist[i];partial+=i*hist[i];
    if(!weight||weight===gray.length)continue;
    const variance=(sum*weight-gray.length*partial)**2/(weight*(gray.length-weight));
    if(variance>best){best=variance;threshold=i;}
  }
  const binary=gray.map(value=>value<=threshold?1:0);
  const patterns=finderPatterns(binary,width,height);
  let chosen=null,error=Infinity;
  for(const tl of patterns)for(const tr of patterns)for(const bl of patterns){
    if(tl===tr||tl===bl||tr===bl||cross(tl.center,tr.center,bl.center)<=0)continue;
    const a=distance(tl.center,tr.center),b=distance(tl.center,bl.center);
    if(a<tl.module*10||b<tl.module*10||a/b<.3||a/b>3)continue;
    const cosine=((tr.center.x-tl.center.x)*(bl.center.x-tl.center.x)+
      (tr.center.y-tl.center.y)*(bl.center.y-tl.center.y))/(a*b);
    if(Math.abs(cosine)>.65)continue;
    const quads=[tl,tr,bl].map(p=>orient(p.quad,tl.center,tr.center,bl.center));
    for(let n=21;n<=177;n+=4){
      const pairs=[];
      for(let k=0;k<3;k++){
        const offsetX=k===1?n-7:0,offsetY=k===2?n-7:0;
        for(let i=0;i<4;i++){
          const [u,v]=[[0,0],[7,0],[7,7],[0,7]][i];
          pairs.push([(offsetX+u)/n,(offsetY+v)/n,quads[k][i].x/width,quads[k][i].y/height]);
        }
      }
      const map=fit(pairs);
      if(!map)continue;
      const residual=pairs.reduce((sum,[u,v,x,y])=>{
        const p=map(u,v);return sum+((p.x-x)*width)**2+((p.y-y)*height)**2;
      },0)/12;
      const corners=[[0,0],[1,0],[1,1],[0,1]].map(([u,v])=>{
        const p=map(u,v);return {x:p.x*width,y:p.y*height};
      });
      if(corners.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.y<0||p.x>width||p.y>height))continue;
      if(corners.some((p,i)=>cross(p,corners[(i+1)%4],corners[(i+2)%4])<=0))continue;
      const normalized=residual/(tl.module**2);
      if(normalized<.2&&normalized<error){chosen=corners;error=normalized;}
    }
  }
  return chosen;
}
