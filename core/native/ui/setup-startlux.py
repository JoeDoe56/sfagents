"""Private first-use install: no administrator rights, PATH changes, or saved credentials."""
import hashlib, json, os, pathlib, platform, shutil, subprocess, sys, tarfile, urllib.request, venv, zipfile

ENGINE = 'a99977d9332decc9fb27a2488b4a83b533b6cd5f'
GGUF_REV = 'a9ab4199fdff586f86e3baf8c9557f6c5ca0fdc0'
TOKENIZER_REV = '416088f77cfce09633906a3675c7cd2e5dabcf10'
MODEL = 'StartLux-Decision-v1.1-4B-Instant'
LLAMA_TAG = 'b12073'
ASSETS = {
    'Windows': [('llama-b12073-bin-win-cuda-12.4-x64.zip', '3a51ea84a1c6815b942cf2e9eb603a035e674ac249f8771efe3b1d3a65ed15ab'),
                ('cudart-llama-bin-win-cuda-12.4-x64.zip', '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6')],
    'Linux': [('llama-b12073-bin-ubuntu-cuda-12.8-x64.tar.gz', '6aa2c019bbebe90c1e43ad1b0d389e9d3c9cb3afb4e33418dfb147b4de114059'),
              ('cudart-llama-b12073-bin-ubuntu-cuda-12.8-x64.tar.gz', '30d58291e9cd06b7c88c7289e845859ae8bdad2f336ad131c1350620f2c2bef5')],
}

def sha(file):
    h = hashlib.sha256()
    with open(file, 'rb') as stream:
        for chunk in iter(lambda: stream.read(4*1024*1024), b''): h.update(chunk)
    return h.hexdigest()

def download(url, dest, checksum):
    if dest.exists() and sha(dest) == checksum: return
    part = dest.with_suffix(dest.suffix+'.part')
    print('Downloading '+dest.name, flush=True)
    have = part.stat().st_size if part.exists() else 0
    request = urllib.request.Request(url, headers={'Range': 'bytes='+str(have)+'-'} if have else {})
    with urllib.request.urlopen(request, timeout=60) as response:
        if have and response.status != 206: have = 0
        with open(part, 'ab' if have else 'wb') as stream:
            last = have
            while True:
                chunk = response.read(4*1024*1024)
                if not chunk: break
                stream.write(chunk); have += len(chunk)
                if have-last >= 64*1024*1024: print(dest.name+': '+str(have//(1024*1024))+' MB', flush=True); last = have
    if sha(part) != checksum: part.unlink(); raise ValueError('Checksum mismatch: '+dest.name)
    part.replace(dest)

def unpack(archive, dest):
    dest.mkdir(parents=True, exist_ok=True)
    if archive.suffix == '.zip':
        with zipfile.ZipFile(archive) as z:
            for name in z.namelist():
                if not (dest/name).resolve().is_relative_to(dest.resolve()): raise ValueError('Archive path escapes install folder')
            z.extractall(dest)
    else:
        with tarfile.open(archive) as t: t.extractall(dest, filter='data')

def main():
    if sys.version_info < (3, 12): raise ValueError('StartLux setup needs Python 3.12 or later. Set SFAGENTS_PYTHON to that interpreter.')
    root = pathlib.Path(sys.argv[1]).resolve(); root.mkdir(parents=True, exist_ok=True)
    if platform.machine().lower() not in ('amd64', 'x86_64') or platform.system() not in ASSETS:
        raise ValueError('Automatic StartLux GPU installation supports Windows and Linux x64 with NVIDIA. Other platforms may use SFAGENTS_LLAMA_SERVER with a compatible GPU build.')
    python = root/'venv'/('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if '--inner' not in sys.argv:
        if not python.exists(): venv.EnvBuilder(with_pip=True).create(root/'venv')
        subprocess.run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check',
                        'https://github.com/StartLuxLabs/StartLux-Decision/archive/'+ENGINE+'.zip', 'transformers>=5.8,<5.9', 'jinja2>=3.1', 'pillow>=12'], check=True)
        subprocess.run([str(python), __file__, str(root), '--inner'], check=True)
        return
    os.environ['HF_HUB_DOWNLOAD_TIMEOUT'] = '60'
    from huggingface_hub import snapshot_download, hf_hub_download
    folder = root/'model'
    snapshot_download('startlux-models/'+MODEL, revision=TOKENIZER_REV, local_dir=folder, token=False,
                      allow_patterns=['*.json','*.jinja','*.txt','LICENSE*'])
    hf = 'https://huggingface.co/startlux-models/'+MODEL+'-GGUF/resolve/'+GGUF_REV+'/'
    model = MODEL+'-Q4_K_M.gguf'; projector = 'mmproj-'+MODEL+'-F16.gguf'
    for name, checksum in [(model, '5fcfe9771db996a868f78215c08955c21cf5e8188609e17e9c653183d946e84d'), (projector, 'cf680df0068c2a6230cc3646baa751b63f6bf32ef26b4289034be2fe5b0cecbc')]:
        print('Downloading '+name, flush=True)
        downloaded = hf_hub_download('startlux-models/'+MODEL+'-GGUF', name, revision=GGUF_REV, local_dir=folder, token=False)
        if sha(downloaded) != checksum: raise ValueError('Model checksum mismatch: '+name)
    runtime = root/'llama'
    if not os.environ.get('SFAGENTS_LLAMA_SERVER'):
        for name, checksum in ASSETS[platform.system()]:
            archive = root/name
            download('https://github.com/ggml-org/llama.cpp/releases/download/'+LLAMA_TAG+'/'+name, archive, checksum)
            unpack(archive, runtime)
        exe = next(runtime.rglob('llama-server.exe' if os.name == 'nt' else 'llama-server'))
    else: exe = pathlib.Path(os.environ['SFAGENTS_LLAMA_SERVER']).resolve()
    (root/'installed.json').write_text(json.dumps({'engine': ENGINE, 'python': str(python), 'llama': str(exe), 'model': str(folder/model), 'projector': str(folder/projector), 'folder': str(folder)}))
    print('StartLux 4B Instant installed.', flush=True)

if __name__ == '__main__': main()
