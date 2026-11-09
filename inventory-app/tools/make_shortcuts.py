#!/usr/bin/env python3
"""iPhone のショートカット2つ（台帳カメラ / 台帳に送る）を作り、Mac の `shortcuts sign` で署名する。

使い方: python3 tools/make_shortcuts.py <出力フォルダ> <サーバーのURL> <合言葉>
  台帳カメラ : 「カメラ」アプリを開く
  台帳に送る : 最新の写真（スクリーンショットを除く・最大20枚）を1枚ずつ送信URLへ POST。
               撮影開始より前の写真はサーバーが撮影日時を見て取り込まない（同じ写真も二重に登録しない）。
アクションの識別子は macOS の Shortcuts の実物（dyld 共有キャッシュ）で確かめたもの（最新の写真＝is.workflow.actions.getlastphoto。
以前の getlatestphotos は存在せず iPhone で「不明なアクション」になった）。
合言葉は「台帳に送る」の中に入る（この2口にしか使えない合言葉）。ファイルは人に渡さないこと。
"""
import plistlib
import subprocess
import sys
import uuid
from pathlib import Path

out_dir, base, key = Path(sys.argv[1]), sys.argv[2].rstrip('/'), sys.argv[3]
out_dir.mkdir(parents=True, exist_ok=True)


def text(s):
    return {'Value': {'string': s, 'attachmentsByRange': {}}, 'WFSerializationType': 'WFTextTokenString'}


def workflow(actions, glyph, color):
    return {
        'WFWorkflowActions': actions,
        'WFWorkflowClientVersion': '2607.0.2',
        'WFWorkflowMinimumClientVersion': 900,
        'WFWorkflowMinimumClientVersionString': '900',
        'WFWorkflowIcon': {'WFWorkflowIconStartColor': color, 'WFWorkflowIconGlyphNumber': glyph},
        'WFWorkflowImportQuestions': [],
        'WFWorkflowTypes': [],
        'WFWorkflowInputContentItemClasses': [],
        'WFWorkflowHasShortcutInputVariables': False,
        'WFWorkflowHasOutputFallback': False,
        'WFQuickActionSurfaces': [],
    }


camera = workflow([{
    'WFWorkflowActionIdentifier': 'is.workflow.actions.openapp',
    'WFWorkflowActionParameters': {
        'WFAppIdentifier': 'com.apple.camera',
        'WFSelectedApp': {'BundleIdentifier': 'com.apple.camera', 'Name': 'カメラ', 'TeamIdentifier': '0000000000'},
    },
}], glyph=59446, color=4282601983)

photos_uuid = str(uuid.uuid4()).upper()
loop = str(uuid.uuid4()).upper()
send = workflow([
    {'WFWorkflowActionIdentifier': 'is.workflow.actions.getlastphoto',
     'WFWorkflowActionParameters': {'UUID': photos_uuid, 'WFGetLatestPhotoCount': 20, 'WFGetLatestPhotosActionIncludeScreenshots': False}},
    {'WFWorkflowActionIdentifier': 'is.workflow.actions.repeat.each',
     'WFWorkflowActionParameters': {'GroupingIdentifier': loop, 'WFControlFlowMode': 0,
                                    'WFInput': {'Value': {'OutputName': '最新の写真', 'OutputUUID': photos_uuid, 'Type': 'ActionOutput'}, 'WFSerializationType': 'WFTextTokenAttachment'}}},
    {'WFWorkflowActionIdentifier': 'is.workflow.actions.downloadurl',
     'WFWorkflowActionParameters': {
         'WFURL': f'{base}/api/native-shoot/photos',
         'WFHTTPMethod': 'POST',
         'WFHTTPBodyType': 'File',
         'WFRequestVariable': {'Value': {'Type': 'Variable', 'VariableName': 'Repeat Item'}, 'WFSerializationType': 'WFTextTokenAttachment'},
         'ShowHeaders': True,
         'WFHTTPHeaders': {'Value': {'WFDictionaryFieldValueItems': [{'WFItemType': 0, 'WFKey': text('x-upload-key'), 'WFValue': text(key)}]}, 'WFSerializationType': 'WFDictionaryFieldValue'},
     }},
    {'WFWorkflowActionIdentifier': 'is.workflow.actions.repeat.each',
     'WFWorkflowActionParameters': {'GroupingIdentifier': loop, 'WFControlFlowMode': 2}},
    {'WFWorkflowActionIdentifier': 'is.workflow.actions.notification',
     'WFWorkflowActionParameters': {'WFNotificationActionTitle': '商品台帳', 'WFNotificationActionBody': '写真を送りました（撮影開始後の分だけ取り込まれます）'}},
], glyph=59511, color=4251333119)

for name, wf in (('台帳カメラ', camera), ('台帳に送る', send)):
    raw = out_dir / f'{name}.unsigned.shortcut'
    raw.write_bytes(plistlib.dumps(wf, fmt=plistlib.FMT_BINARY))
    signed = out_dir / f'{name}.shortcut'
    r = subprocess.run(['shortcuts', 'sign', '--mode', 'anyone', '--input', str(raw), '--output', str(signed)], capture_output=True, text=True)
    raw.unlink()
    print(name, 'OK' if r.returncode == 0 and signed.exists() else f'NG {r.stderr.strip()[:200]}')
