"""Durable Telegram notifications. Approval links require a signed-in owner and a POST decision."""
import json
import threading
import time
from urllib.parse import urlencode, urlsplit
from audit import record

class ApprovalNotifier:
    def __init__(self, accounts, send, chat_id, origin):
        if not str(chat_id).lstrip('-').isdigit() or urlsplit(origin).scheme!='https' or urlsplit(origin).path:
            raise ValueError('A verified Telegram destination and public HTTPS origin are required.')
        self.accounts,self.send,self.chat_id,self.origin=accounts,send,str(chat_id),origin
        self.stop=threading.Event()
    def once(self):
        counts={'sent':0,'uncertain':0}
        with self.accounts.db() as db:
            rows=[dict(r) for r in db.execute("SELECT u.uid,u.email,u.tenant FROM users u JOIN notifications n ON n.uid=u.uid WHERE u.status='pending' AND n.state='pending' LIMIT 5")]
        for user in rows:
            with self.accounts.db() as db:
                claimed=db.execute("UPDATE notifications SET state='sending',attempts=attempts+1 WHERE uid=? AND state='pending'",(user['uid'],)).rowcount
            if not claimed:continue
            approve=self.origin+'/login?'+urlencode({'manage':1,'review':user['tenant'],'decision':'approve'})
            deny=self.origin+'/login?'+urlencode({'manage':1,'review':user['tenant'],'decision':'deny'})
            text='Echo Workspace account request\n'+user['email']+'\n\nApprove: '+approve+'\n\nDeny: '+deny+'\n\nOnly the signed-in owner can confirm either decision. No access is granted until approval.'
            try:
                result=self.send('echo.social.telegram_post','telegram_post',{'chat_id':self.chat_id,'text':text})
                message=result.get('message_id')
                if not message and isinstance(result.get('result'),dict):message=result['result'].get('message_id')
                if result.get('ok') is False or not isinstance(message,int):raise ValueError('No Telegram message receipt')
                with self.accounts.db() as db:db.execute("UPDATE notifications SET state='sent',receipt=? WHERE uid=?",(json.dumps({'message_id':message}),user['uid']))
                counts['sent']+=1
                record(self.accounts.audit,operation='approval_notification',status='sent',tenant=user['tenant'],verification='telegram_message_id')
            except Exception as exc:
                # A timeout may already have sent the message: do not create duplicate notifications.
                with self.accounts.db() as db:db.execute("UPDATE notifications SET state='uncertain' WHERE uid=?",(user['uid'],))
                counts['uncertain']+=1
                record(self.accounts.audit,operation='approval_notification',status='uncertain',tenant=user['tenant'],error_category=type(exc).__name__)
        return counts
    def start(self):
        def loop():
            while not self.stop.is_set():
                try:self.once()
                except Exception as exc:record(self.accounts.audit,operation='approval_notifications',status='error',error_category=type(exc).__name__)
                self.stop.wait(10)
        threading.Thread(target=loop,daemon=True,name='workspace-approvals').start()
