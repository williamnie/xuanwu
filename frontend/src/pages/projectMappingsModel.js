export function projectMappingRows(value = '') {
  const rows=[];
  for(const match of String(value).matchAll(/[^,\n]+/g)){
    const raw=match[0],separator=raw.indexOf('=');if(separator<0)continue;
    const source=raw.slice(0,separator).trim(),project=raw.slice(separator+1).trim();
    if(!/^(?:(?:chat|user):)?-?[1-9]\d*$/.test(source)||!project)continue;
    rows.push({start:match.index,end:match.index+raw.length,raw,source,project});
  }
  return rows;
}
export function updateProjectMapping(value,row,{source=row.source,project=row.project}={}){
  const leading=/^\s*/.exec(row.raw)[0],trailing=/\s*$/.exec(row.raw)[0];
  return value.slice(0,row.start)+`${leading}${source}=${project}${trailing}`+value.slice(row.end);
}
export function removeProjectMapping(value,row){return value.slice(0,row.start)+value.slice(row.end);}
export function appendProjectMapping(value,source,project){return `${value}${value&&!/[,\n]$/.test(value)?',':''}${source}=${project}`;}
