/* shared: keep the active tab visible in the scrollable tab bar (mobile) */
(function(){var t=document.querySelector('.tabs .tab[aria-selected="true"]');if(!t)return;
 var go=function(){var bar=t.parentElement;bar.scrollLeft=Math.max(0,t.offsetLeft-(bar.clientWidth-t.offsetWidth)/2)};
 go();addEventListener('load',go);addEventListener('resize',go)})();

/* shared: show the connected LinkedIn profile photo instead of the placeholder face */
(function(){var pic=null;
 function swap(svg){if(svg.dataset.pic)return;svg.dataset.pic="1";var img=new Image();
  img.className=svg.getAttribute("class")||"av";var st=svg.getAttribute("style");if(st)img.setAttribute("style",st);
  img.alt="";img.referrerPolicy="no-referrer";img.style.objectFit="cover";
  img.onload=function(){if(svg.parentNode)svg.replaceWith(img)};img.src=pic}
 function run(root){if(root.matches&&root.matches("svg.av")&&root.querySelector('use[href="#face"]'))swap(root);root.querySelectorAll('svg.av use[href="#face"]').forEach(function(u){swap(u.parentNode)})}
 fetch("/linkedin/api/accounts",{credentials:"same-origin"}).then(function(r){return r.ok?r.json():[]}).then(function(acc){
  var a=(acc||[]).find(function(x){return x.kind==="member"&&x.picture});if(!a)return;pic=a.picture;run(document);
  new MutationObserver(function(ms){ms.forEach(function(m){m.addedNodes.forEach(function(n){if(n.nodeType===1)run(n)})})}).observe(document.body,{childList:true,subtree:true})
 }).catch(function(){})})();
