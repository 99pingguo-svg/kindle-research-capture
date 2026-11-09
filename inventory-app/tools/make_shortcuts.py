#!/usr/bin/env python3
"""iPhone のショートカット2つ（台帳で撮る / 台帳に送る）を作り、Mac の `shortcuts sign` で署名する。

使い方: python3 tools/make_shortcuts.py <出力フォルダ> <サーバーのURL> <合言葉>
  台帳で撮る : 「カメラ」アプリを開く → 撮ったら左上の「◀ ショートカット」で戻る（戻るまで待機）→
               最新の写真（スクリーンショットを除く・最大15枚）を1枚ずつ送信URLへ POST（Mac の撮影トレイへ）→
               Mac が受け取った写真だけ iPhone から削除（iOS が枚数つきで確認）→ 通知。Webアプリの「純正カメラで撮る」から呼ぶ。
  台帳に送る : 送り直し用。最新の写真（最大20枚）を送るだけ。
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


OPEN_CAMERA = {
    'WFWorkflowActionIdentifier': 'is.workflow.actions.openapp',
    'WFWorkflowActionParameters': {
        'WFAppIdentifier': 'com.apple.camera',
        'WFSelectedApp': {'BundleIdentifier': 'com.apple.camera', 'Name': 'カメラ', 'TeamIdentifier': '0000000000'},
    },
}


SENT = '台帳に届いた写真'


def var(name):
    return {'Value': {'Type': 'Variable', 'VariableName': name}, 'WFSerializationType': 'WFTextTokenAttachment'}


def send_actions(count, done_message, delete_after=False):
    """最新の写真 count 枚を1枚ずつ送信URLへ POST して、最後に通知。
    delete_after: Mac が受け取った写真（応答に trayId がある＝撮影開始後の写真）だけを集め、iPhone から削除する。
    削除の前に iOS が枚数つきで確認を出す（取り消せる・「最近削除した項目」に30日残る）。撮影前の写真は応答に trayId がないので消さない。"""
    photos_uuid = str(uuid.uuid4()).upper()
    loop = str(uuid.uuid4()).upper()
    dl_uuid = str(uuid.uuid4()).upper()
    got = str(uuid.uuid4()).upper()
    has_any = str(uuid.uuid4()).upper()
    keep = [] if not delete_after else [
        {'WFWorkflowActionIdentifier': 'is.workflow.actions.conditional',
         'WFWorkflowActionParameters': {'GroupingIdentifier': got, 'WFControlFlowMode': 0, 'WFCondition': 99, 'WFConditionalActionString': 'trayId',
                                        'WFInput': {'Type': 'Variable', 'Variable': {'Value': {'OutputName': 'URLの内容', 'OutputUUID': dl_uuid, 'Type': 'ActionOutput'}, 'WFSerializationType': 'WFTextTokenAttachment'}}}},
        {'WFWorkflowActionIdentifier': 'is.workflow.actions.appendvariable',
         'WFWorkflowActionParameters': {'WFVariableName': SENT, 'WFInput': var('Repeat Item')}},
        {'WFWorkflowActionIdentifier': 'is.workflow.actions.conditional',
         'WFWorkflowActionParameters': {'GroupingIdentifier': got, 'WFControlFlowMode': 2}},
    ]
    delete = [] if not delete_after else [
        {'WFWorkflowActionIdentifier': 'is.workflow.actions.conditional',
         'WFWorkflowActionParameters': {'GroupingIdentifier': has_any, 'WFControlFlowMode': 0, 'WFCondition': 100,
                                        'WFInput': {'Type': 'Variable', 'Variable': var(SENT)}}},
        # (the variable is also the implicit input, whichever parameter key this iOS uses for the photos)
        {'WFWorkflowActionIdentifier': 'is.workflow.actions.getvariable', 'WFWorkflowActionParameters': {'WFVariable': var(SENT)}},
        {'WFWorkflowActionIdentifier': 'is.workflow.actions.deletephotos', 'WFWorkflowActionParameters': {'photos': var(SENT)}},
        {'WFWorkflowActionIdentifier': 'is.workflow.actions.conditional',
         'WFWorkflowActionParameters': {'GroupingIdentifier': has_any, 'WFControlFlowMode': 2}},
    ]
    return [
        {'WFWorkflowActionIdentifier': 'is.workflow.actions.getlastphoto',
         'WFWorkflowActionParameters': {'UUID': photos_uuid, 'WFGetLatestPhotoCount': count, 'WFGetLatestPhotosActionIncludeScreenshots': False}},
        {'WFWorkflowActionIdentifier': 'is.workflow.actions.repeat.each',
         'WFWorkflowActionParameters': {'GroupingIdentifier': loop, 'WFControlFlowMode': 0,
                                        'WFInput': {'Value': {'OutputName': '最新の写真', 'OutputUUID': photos_uuid, 'Type': 'ActionOutput'}, 'WFSerializationType': 'WFTextTokenAttachment'}}},
        {'WFWorkflowActionIdentifier': 'is.workflow.actions.downloadurl',
         'WFWorkflowActionParameters': {
             'UUID': dl_uuid,
             'WFURL': f'{base}/api/native-shoot/photos',
             'WFHTTPMethod': 'POST',
             'WFHTTPBodyType': 'File',
             'WFRequestVariable': {'Value': {'Type': 'Variable', 'VariableName': 'Repeat Item'}, 'WFSerializationType': 'WFTextTokenAttachment'},
             'ShowHeaders': True,
             'WFHTTPHeaders': {'Value': {'WFDictionaryFieldValueItems': [{'WFItemType': 0, 'WFKey': text('x-upload-key'), 'WFValue': text(key)}]}, 'WFSerializationType': 'WFDictionaryFieldValue'},
         }},
        *keep,
        {'WFWorkflowActionIdentifier': 'is.workflow.actions.repeat.each',
         'WFWorkflowActionParameters': {'GroupingIdentifier': loop, 'WFControlFlowMode': 2}},
        *delete,
        {'WFWorkflowActionIdentifier': 'is.workflow.actions.notification',
         'WFWorkflowActionParameters': {'WFNotificationActionTitle': '商品台帳', 'WFNotificationActionBody': done_message}},
    ]


# 台帳で撮る: カメラを開き、ユーザーが「◀ ショートカット」で戻るまで待ってから送る（1つで撮影〜取り込みまで）。
shoot = workflow(
    [OPEN_CAMERA, {'WFWorkflowActionIdentifier': 'is.workflow.actions.waittoreturn', 'WFWorkflowActionParameters': {}}]
    + send_actions(15, '撮った写真を Mac に送りました。台帳に戻って、登録・保留・破棄を選んでください', delete_after=True),
    glyph=59446, color=4282601983)
send = workflow(send_actions(20, '写真を送りました（撮影開始後の分だけ取り込まれます）'), glyph=59511, color=4251333119)

for name, wf in (('台帳で撮る', shoot), ('台帳に送る', send)):
    raw = out_dir / f'{name}.unsigned.shortcut'
    raw.write_bytes(plistlib.dumps(wf, fmt=plistlib.FMT_BINARY))
    signed = out_dir / f'{name}.shortcut'
    r = subprocess.run(['shortcuts', 'sign', '--mode', 'anyone', '--input', str(raw), '--output', str(signed)], capture_output=True, text=True)
    raw.unlink()
    print(name, 'OK' if r.returncode == 0 and signed.exists() else f'NG {r.stderr.strip()[:200]}')
