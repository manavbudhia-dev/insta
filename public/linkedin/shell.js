/* shared: keep the active tab visible in the scrollable tab bar (mobile) */
(function(){var t=document.querySelector('.tabs .tab[aria-selected="true"]');if(!t)return;
 var go=function(){var bar=t.parentElement;bar.scrollLeft=Math.max(0,t.offsetLeft-(bar.clientWidth-t.offsetWidth)/2)};
 go();addEventListener('load',go);addEventListener('resize',go)})();
