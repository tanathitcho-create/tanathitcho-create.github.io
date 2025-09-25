#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import asyncio, json, os, shlex, subprocess, websockets

WS_HOST="0.0.0.0"; WS_PORT=8765
IFACE=os.environ.get("WIFI_IFACE","wlan0")
CANDS=["wlan_radio.signal_dbm","radiotap.dbm_antsignal","prism.signal_data","radiotap.db_antsignal"]

def has_values(field):
    p=subprocess.run(["tshark","-i",IFACE,"-I","-l","-c","5","-T","fields","-e",field],
                     capture_output=True,text=True)
    return p.returncode==0 and any(x.strip() for x in p.stdout.splitlines())

def pick_field():
    for f in CANDS:
        if has_values(f): return f
    return None

async def serve(ws):
    rssi_field=pick_field()
    if not rssi_field:
        await ws.send(json.dumps({"type":"status","ok":False,"msg":"No RSSI field (need monitor mode)"})); return
    await ws.send(json.dumps({"type":"status","ok":True,"msg":f"Using {rssi_field}"}))
    fields=["frame.time_epoch","wlan.bssid","wlan.ssid",rssi_field]
    cmd=["tshark","-i",IFACE,"-I","-l","-Y","wlan.fc.type_subtype==8","-T","fields",
         "-E","separator=/t","-E","quote=n","-E","occurrence=f"]
    for f in fields: cmd+=["-e",f]
    proc=subprocess.Popen(cmd,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1)
    await ws.send(json.dumps({"type":"header","cols":["time","bssid","ssid","rssi_dbm"]}))
    for line in proc.stdout:
        t,b,ssid,r = (line.rstrip("\n").split("\t")+["","","",""])[:4]
        if not t or not r: continue
        await ws.send(json.dumps({"type":"sample","time":float(t),
                                  "bssid":b or None,"ssid":ssid or None,"rssi_dbm":float(r)}))

async def main():
    async with websockets.serve(lambda ws, p: serve(ws), WS_HOST, WS_PORT):
        await asyncio.Future()

if __name__=="__main__":
    try: asyncio.run(main())
    except KeyboardInterrupt: pass
