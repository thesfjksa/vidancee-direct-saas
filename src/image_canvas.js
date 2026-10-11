'use strict';

function dimensions(data,mime) {
  if(mime==='image/png'&&data.length>=24&&data.toString('ascii',12,16)==='IHDR')
    return {width:data.readUInt32BE(16),height:data.readUInt32BE(20)};
  if(mime==='image/jpeg') {
    let offset=2;
    while(offset+4<data.length) {
      if(data[offset++]!==255)continue;
      let marker=data[offset++];while(marker===255&&offset<data.length)marker=data[offset++];
      if(marker===217||marker===218)break;
      if(marker===216||marker===1||marker>=208&&marker<=215)continue;
      const length=data.readUInt16BE(offset);
      if(length<2||offset+length>data.length)break;
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&length>=7)
        return {width:data.readUInt16BE(offset+5),height:data.readUInt16BE(offset+3)};
      offset+=length;
    }
  }
  if(mime==='image/webp'&&data.length>=30) {
    const kind=data.toString('ascii',12,16);
    if(kind==='VP8X')return {width:1+data.readUIntLE(24,3),height:1+data.readUIntLE(27,3)};
    if(kind==='VP8L'&&data[20]===47){const bits=data.readUInt32LE(21);return {width:1+(bits&16383),height:1+((bits>>>14)&16383)};}
    if(kind==='VP8 '&&data.subarray(23,26).equals(Buffer.from([157,1,42])))
      return {width:data.readUInt16LE(26)&16383,height:data.readUInt16LE(28)&16383};
  }
  throw new Error('The generated image has invalid canvas dimensions.');
}

function validateCanvas(data,mime,ratio) {
  const result=dimensions(data,mime),{width,height}=result;
  const [w,h]=ratio.split(':').map(Number);
  if(!width||!height||width>16384||height>16384||width*height>64*1024*1024||!w||!h)
    throw new Error('The generated image has invalid canvas dimensions.');
  // Providers use slightly different preset dimensions. Permit their rounding,
  // but never accept the opposite orientation or a different requested shape.
  // Recraft 3:2 is 1280x832 (2.6% off); distinct shapes such as 4:3 vs 5:4 differ by 6.7%.
  if((w<h&&width>=height)||(w>h&&width<=height)||Math.abs((width/height)/(w/h)-1)>0.03)
    throw new Error('The image service returned a different aspect ratio. Credits were refunded.');
  return result;
}

module.exports={dimensions,validateCanvas};
