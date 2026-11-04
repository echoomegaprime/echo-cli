'use strict';
function renderMcpConnections() {
  const list=E('div',{class:'card-grid'});
  const root=E('section',{class:'mcp-connections'},E('div',{class:'row'},E('h2',{},'MCP connections'),B('＋ Add MCP server',addDialog,'primary')),E('p',{class:'muted'},'Connect a server by URL. Echo can discover and use its tools in your chats.'),list);
  async function load() {
    try {
      const data=await api('/api/mcp');
      list.replaceChildren(...data.connections.map(connection=>card(connection.name,connection.url,
        E('span',{class:'pill '+(connection.enabled?'good':'pending')},connection.enabled?'Enabled':'Disabled'),
        E('p',{class:'muted'},connection.tool_count+' tools · '+(connection.auth==='bearer'?'Encrypted credential':'No authentication')+' · checked '+new Date(connection.checked*1000).toLocaleString()),
        E('div',{class:'row'},
          B('View tools',async()=>{const data=await api('/api/mcp/tools/'+connection.id);modal(connection.name+' tools',E('p',{class:'muted'},'Echo reads these schemas before calling this connection. Server output is treated as external content.'),...data.tools.map(tool=>card(tool.name,tool.description,pre(tool.inputSchema))));}),
          B(connection.enabled?'Disable':'Enable',async()=>{await api('/api/mcp',{action:'enable',id:connection.id,enabled:!connection.enabled});await load();}),
          B('Remove',async()=>{modal('Remove '+connection.name+'?',E('p',{},'Disconnect this server and remove its saved credential from your account.'),B('Remove connection',async()=>{await api('/api/mcp',{action:'remove',id:connection.id});closeModal();await load();}));})
        ))));
      if(!data.connections.length)list.append(card('Bring your tools to Echo.','Add a public HTTPS MCP server to get started. Connections are private to this account.'));
    } catch(e){list.replaceChildren(E('p',{class:'muted'},e.message));}
  }
  function addDialog() {
    const name=input('e.g. Documentation'),url=input('https://server.example.com/mcp');
    url.type='url';url.autocomplete='off';
    const auth=E('select',{},E('option',{value:'none'},'No authentication'),E('option',{value:'bearer'},'Bearer token'));
    const token=E('input',{type:'password',autocomplete:'off',placeholder:'Paste this server’s token'});
    const tokenField=field('Bearer token',token);tokenField.classList.add('mcp-token-field');tokenField.hidden=true;
    auth.addEventListener('change',()=>{tokenField.hidden=auth.value!=='bearer';if(auth.value==='none')token.value='';});
    const status=E('p',{role:'status',class:'muted'});
    const connect=B('Connect & discover tools',async()=>{
      connect.disabled=true;status.textContent='Connecting and discovering tools…';
      try {
        const connection=await api('/api/mcp',{action:'add',name:name.value,url:url.value,auth:auth.value,token:token.value});
        token.value='';closeModal();toast(connection.name+' connected · '+connection.tool_count+' tools');await load();
      } catch(e){status.textContent=e.message;}
      finally{token.value='';connect.disabled=false;}
    },'primary');
    modal('Add MCP server',E('p',{class:'muted'},'Use a Streamable HTTP endpoint, usually /mcp. The server receives the arguments Echo sends to its tools.'),field('Connection name',name),field('Server URL',url),field('Authentication',auth),tokenField,E('p',{class:'muted'},'Tokens are encrypted on this host and are never put into chat context. OAuth sign-in and legacy SSE-only endpoints are not supported yet.'),status,connect);
  }
  load();return root;
}
