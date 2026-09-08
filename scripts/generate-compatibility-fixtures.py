"""Regenerate small independent fixtures: Python with reportlab, and FFmpeg on PATH."""
from pathlib import Path
import json
import subprocess
import importlib.metadata
from reportlab.pdfgen.canvas import Canvas
from reportlab.lib.pdfencrypt import StandardEncryption
from reportlab.graphics.barcode.qrencoder import QRCode, QRErrorCorrectLevel

out = Path(__file__).resolve().parent.parent / 'tests' / 'fixtures'
out.mkdir(exist_ok=True)
for encrypted in [False, True]:
    path = out / ('reportlab-encrypted.pdf' if encrypted else 'reportlab.pdf')
    c = Canvas(str(path), pagesize=(612, 792), invariant=1, pageCompression=1,
               encrypt=StandardEncryption('fixture-password') if encrypted else None)
    for text in ['Independent fixture page one', 'Independent fixture page two']:
        c.drawString(72, 720, text)
        c.showPage()
    c.save()

codes = []
for version, level, text in [(1, 'L', '1234567890'), (3, 'M', 'https://alexmerced.app'), (7, 'Q', 'Independent QR fixture'), (10, 'H', 'HELLO WORLD 123')]:
    code = QRCode(version, getattr(QRErrorCorrectLevel, level))
    code.addData(text)
    code.make()
    codes.append(dict(version=version, ec=level, text=text, modules=code.modules))
(out / 'reportlab-qr.json').write_text(json.dumps(codes, separators=(',', ':')) + '\n')

base = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y']
subprocess.run(base + ['-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=5:duration=1', '-an', '-c:v', 'libvpx', '-threads', '1', '-map_metadata', '-1', str(out / 'ffmpeg-vp8.webm')], check=True)
subprocess.run(base + ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000:duration=0.1', '-c:a', 'pcm_s16le', '-map_metadata', '-1', str(out / 'ffmpeg-pcm.wav')], check=True)
for name, colour, frequency, seconds in [('blue', '0x185adb', 440, 1.4), ('orange', '0xdc6b19', 660, 1.8)]:
    subprocess.run(base + ['-f', 'lavfi', '-i', f'color=c={colour}:size=320x180:rate=12',
                          '-f', 'lavfi', '-i', f'sine=frequency={frequency}:sample_rate=48000',
                          '-t', str(seconds), '-c:v', 'libvpx', '-c:a', 'libopus', '-threads', '1',
                          '-map_metadata', '-1', str(out / f'ffmpeg-{name}.webm')], check=True)

(out / 'provenance.json').write_text(json.dumps({'reportlab': importlib.metadata.version('reportlab'), 'ffmpeg': subprocess.check_output(['ffmpeg', '-version'], text=True).splitlines()[0], 'source': 'scripts/generate-compatibility-fixtures.py', 'content': 'Synthetic text, QR payloads, test pattern and sine wave; no user data.'}, indent=2) + '\n')
