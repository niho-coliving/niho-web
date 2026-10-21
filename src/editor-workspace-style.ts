/** STUDIO を視覚基準にした、全サイト共通の編集 workspace。 */
export const workspaceCss = `
/* Tokens and shared controls */
.nw-editor{
  --e-ink:#1f1f1f;--e-muted:#737373;--e-border:#e6e6e6;--e-border-strong:#d5d5d5;
  --e-ground:#f3f3f3;--e-input:#f5f5f5;--e-hover:#eee;--e-blue:#2878ff;--e-blue-soft:#edf4ff;--e-green:#1f5a3e;--e-soft:#f1f3f1;--e-part:#6d4bc3;
  display:flex;width:100%;height:100dvh;max-height:100dvh;min-width:320px;min-height:0;flex-direction:column;overflow:hidden;
  border:0;border-radius:0;background:var(--e-ground);color:var(--e-ink);font:12px/1.45 Inter,"Noto Sans JP",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif
}
.nw-editor *{box-sizing:border-box}.nw-editor [hidden]{display:none!important}
.nw-editor button,.nw-editor input,.nw-editor select,.nw-editor textarea{font:inherit;color:inherit}
.nw-editor button{min-height:30px;padding:5px 9px;border:1px solid var(--e-border-strong);border-radius:5px;background:#fff;cursor:pointer;transition:background .15s,border-color .15s,box-shadow .15s}
.nw-editor button:hover:not(:disabled){border-color:#c8c8c8;background:var(--e-hover)}.nw-editor button:disabled{cursor:default;opacity:.45}
.nw-editor button:focus-visible,.nw-editor input:focus-visible,.nw-editor select:focus-visible,.nw-editor textarea:focus-visible,.nw-editor summary:focus-visible{outline:2px solid var(--e-blue);outline-offset:2px}
.nw-editor button[aria-pressed=true]{border-color:#cbdcff;background:var(--e-blue-soft);color:#155cc7}
.nw-editor input:not([type=checkbox]),.nw-editor select,.nw-editor textarea{display:block;width:100%;min-width:0;padding:6px 8px;border:1px solid var(--e-border);border-radius:5px;background:var(--e-input)}
.nw-editor textarea{min-height:90px;resize:vertical}.nw-editor :is(input,select,textarea):disabled{background:#ececec}.nw-editor :is(input,textarea)::placeholder{color:#929292;opacity:1}
.nw-editor .e-primary{border-color:#171717;background:#171717;color:#fff;font-weight:700}.nw-editor .e-primary:hover:not(:disabled){border-color:#303030;background:#303030;color:#fff}.nw-editor .e-danger{color:#9c3e35}
.nw-editor h2{margin:0 0 12px;font-size:14px}.nw-editor h3{margin:20px 0 8px;color:var(--e-muted);font-size:11px;letter-spacing:.05em}
.nw-editor .e-field{display:block;margin:0 0 11px}.nw-editor .e-field>span{display:block;margin:0 0 4px;color:#4e4e4e;font-size:11px;font-weight:700}
.nw-editor .e-help{display:block;margin-top:5px;color:var(--e-muted);font-size:11px;overflow-wrap:anywhere}.nw-editor .e-problem{color:#9b3b31}
.nw-editor .e-actions{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}.nw-editor .e-small{padding:5px 8px;font-size:11px}.nw-editor .e-search{margin:4px 0 12px}
.nw-editor .e-domain-small{padding:8px;border-radius:5px;background:#f2f2f2;font-size:11px;word-break:break-all}

/* Workspace columns and bounded scrolling */
.nw-editor .e-body{position:relative;display:grid;grid-template-columns:296px minmax(0,1fr) 300px;min-height:0;flex:1;overflow:hidden}
.nw-editor .e-body.is-left-closed{grid-template-columns:44px minmax(0,1fr) 300px}.nw-editor .e-body.is-right-closed{grid-template-columns:296px minmax(0,1fr)}.nw-editor .e-body.is-left-closed.is-right-closed{grid-template-columns:44px minmax(0,1fr)}
.nw-editor .e-rail{height:100%;min-height:0;background:#fff}.nw-editor .e-left{display:flex;min-width:0;overflow:hidden;border-right:1px solid var(--e-border)}
.nw-editor .e-tools{display:flex;width:44px;flex:none;flex-direction:column;align-items:center;gap:3px;padding:7px 4px;border-right:1px solid var(--e-border);background:#fff}
.nw-editor .e-tools button{display:flex;width:36px;height:36px;min-width:36px;min-height:36px;align-items:center;justify-content:center;padding:0;border:0;border-radius:5px;background:transparent;color:#666}
.nw-editor .e-tools button:hover:not(:disabled),.nw-editor .e-tools button[aria-pressed=true]{border-color:transparent;background:var(--e-hover);color:#222}.nw-editor .e-tool-icon{display:block;width:19px;height:19px;flex:none}
.nw-editor .e-left-column{display:flex;min-width:0;min-height:0;flex:1;flex-direction:column}.nw-editor .e-body.is-left-closed .e-left-column{display:none}.nw-editor .e-project-context{display:grid;min-height:48px;grid-template-columns:32px minmax(0,1fr);grid-template-rows:20px 16px;align-content:center;padding:4px 8px;border-bottom:1px solid var(--e-border)}
.nw-editor .e-toolbar-start{display:flex;grid-row:1/3;align-items:center}.nw-editor .e-toolbar-start>a{display:grid;width:30px;height:30px;place-items:center;border-radius:5px;color:#333;text-decoration:none}.nw-editor .e-toolbar-start>a:hover{background:var(--e-hover)}
.nw-editor .e-crumb,.nw-editor .e-project-context>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nw-editor .e-crumb{font-size:12px}.nw-editor .e-project-context>span{color:var(--e-muted);font-size:10px}
.nw-editor .e-panel{min-width:0;min-height:0;flex:1;overflow:auto}.nw-editor .e-panel>section{padding:14px 12px 22px}.nw-editor .e-panel-head{margin-bottom:12px}.nw-editor .e-panel-head h2{margin:0;font-size:13px}.nw-editor .e-panel-head p{display:none}

/* Canvas begins at the workspace top; only the stage scrolls. */
.nw-editor .e-canvas{position:relative;display:flex;min-width:0;min-height:0;flex-direction:column;overflow:hidden;background:var(--e-ground)}
.nw-editor .e-stage{min-height:0;flex:1;overflow:auto;padding:20px 20px 84px;background:var(--e-ground)}
.nw-editor .e-canvas-spacer{position:relative;flex:none;margin:0 auto}.nw-editor .e-canvas-scaled{position:absolute;top:0;left:0;transform-origin:top left}
.nw-editor iframe{display:block;height:800px;max-width:none;margin:0 auto;border:1px solid #dedede;background:#fff;box-shadow:0 2px 8px #00000012}.nw-editor .e-empty{padding:40px;color:var(--e-muted);text-align:center}
.nw-editor .e-canvas-tools{position:absolute;z-index:10;bottom:16px;left:50%;display:flex;width:auto;height:42px;min-height:42px;max-width:calc(100% - 24px);align-items:center;justify-content:center;gap:5px;padding:5px 7px;border:1px solid #dedede;border-radius:7px;background:#fff;box-shadow:0 3px 14px #00000014;transform:translateX(-50%)}
.nw-editor .e-width-field{display:flex;width:80px;align-items:center;color:var(--e-muted);white-space:nowrap}.nw-editor .e-width-field input{width:58px;height:30px;padding:4px 3px 4px 7px;border:0;background:transparent;text-align:right;font-variant-numeric:tabular-nums}
.nw-editor .e-device-group{display:flex;align-items:center;gap:1px;padding:2px;border-radius:5px;background:var(--e-input)}.nw-editor .e-device-button{display:grid;width:30px;height:28px;min-width:30px;min-height:28px;place-items:center;padding:0;border:0;background:transparent}
.nw-editor .e-device-button[aria-pressed=true]{background:#fff;color:var(--e-blue);box-shadow:0 1px 3px #00000016}.nw-editor .e-device-button .e-action-icon{width:16px;height:16px}
.nw-editor .e-canvas-tools .e-motion-toggle{width:30px;min-width:30px;height:30px;overflow:hidden;padding:0;color:transparent}.nw-editor .e-canvas-tools .e-motion-toggle::before{content:"▶";display:grid;width:30px;height:30px;place-items:center;color:#444;font-size:11px}
.nw-editor .e-tier-note,.nw-editor .e-canvas-caption{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.nw-editor .e-preview-exit{position:absolute;z-index:12;top:12px;right:12px;display:flex;align-items:center;gap:6px;box-shadow:0 3px 14px #0002}.nw-editor .e-preview-exit .e-action-icon{width:16px;height:16px}

/* Inspector owns document actions and its own scroll container. */
.nw-editor .e-right{display:flex;min-width:0;min-height:0;flex-direction:column;overflow:hidden;border-left:1px solid var(--e-border);background:#fff}
.nw-editor .e-inspector-actions{display:flex;min-height:49px;flex:none;flex-wrap:wrap;align-items:center;gap:2px;padding:7px;border-bottom:1px solid var(--e-border);background:#fff}
.nw-editor .e-inspector-actions .e-status{order:20;min-width:0;flex:1 1 110px;padding:3px 4px;overflow:hidden;color:var(--e-muted);font-size:10px;white-space:nowrap;text-overflow:ellipsis}.nw-editor .e-inspector-actions .e-status.is-dirty{color:#87591f}.nw-editor .e-inspector-actions .e-status.is-problem{color:#9b3b31;font-weight:700}
.nw-editor .e-inspector-actions .e-status-action{order:21;min-height:24px;padding:2px 6px}.nw-editor .e-inspector-actions .e-autosave{order:22;min-height:24px;margin-left:auto;padding:2px 4px;font-size:10px}.nw-editor .e-inspector-actions .e-language-selector{order:19;width:100%;overflow-x:auto}
.nw-editor .e-action-button,.nw-editor .e-panel-toggle{display:grid;width:28px;height:30px;min-width:28px;min-height:30px;place-items:center;padding:0;border-color:transparent;background:transparent}
.nw-editor .e-action-button:hover:not(:disabled),.nw-editor .e-panel-toggle:hover:not(:disabled){border-color:transparent;background:var(--e-hover)}.nw-editor .e-action-icon{display:block;width:17px;height:17px}.nw-editor .e-save-button{color:#333}
.nw-editor .e-zoom-field{margin-right:auto}.nw-editor .e-zoom-field select{width:72px;height:30px;padding:3px 5px;border:0;background:var(--e-input)}
.nw-editor .e-publish-button{min-width:50px;min-height:30px;padding:4px 10px;border-color:#171717;background:#171717;color:#fff;font-size:11px}.nw-editor .e-hold{display:none}
.nw-editor .e-inspector-scroll{min-height:0;flex:1;overflow:auto}.nw-editor .e-inspector-context{position:sticky;z-index:4;top:0;display:flex;min-height:46px;align-items:center;gap:6px;padding:7px 9px;border-bottom:1px solid var(--e-border);background:#fff}
.nw-editor .e-inspector-context strong{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}.nw-editor .e-inspector-context label{flex:0 0 auto;margin:0}.nw-editor .e-inspector-context select{width:auto;max-width:86px;height:30px;padding:4px 23px 4px 7px}.nw-editor .e-condition-select{max-width:92px!important}
.nw-editor .e-inspector-tabs{position:sticky;z-index:3;top:46px;display:flex;gap:3px;padding:6px 8px;border-bottom:1px solid var(--e-border);background:#fff}.nw-editor .e-inspector-tabs button{height:30px;flex:1;padding:4px 5px;border:0;border-radius:5px;background:transparent;color:var(--e-muted)}.nw-editor .e-inspector-tabs button[aria-selected=true]{background:var(--e-hover);color:#222;font-weight:700}
.nw-editor .e-inspector-content{padding:13px 10px 28px}
.nw-editor .e-notice,.nw-editor .e-readonly,.nw-editor .e-localization-gate{max-height:96px;flex:none;overflow:auto}.nw-editor .e-notice{padding:8px 12px;border-bottom:1px solid #ead9ae;background:#fff8e8;overflow-wrap:anywhere}

.nw-editor.is-preview .e-body{grid-template-columns:minmax(0,1fr)}.nw-editor.is-preview .e-left,.nw-editor.is-preview .e-right{display:none}.nw-editor.is-preview .e-canvas-tools{display:flex}
@media(max-width:1050px){.nw-editor .e-body{grid-template-columns:276px minmax(0,1fr) 292px}}
@media(max-width:820px){
  .nw-editor .e-body,.nw-editor .e-body.is-left-closed,.nw-editor .e-body.is-right-closed,.nw-editor .e-body.is-left-closed.is-right-closed{display:grid;grid-template-columns:minmax(0,1fr)}
  .nw-editor .e-left,.nw-editor .e-right{position:absolute;z-index:20;inset-block:0;width:min(296px,calc(100vw - 44px));box-shadow:6px 0 24px #0002}.nw-editor .e-left{left:0}.nw-editor .e-right{right:0;left:auto;box-shadow:-6px 0 24px #0002}
  .nw-editor .e-body.is-left-closed .e-left{width:44px;box-shadow:none}
}
`;
