const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

// ─── Configuração ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const API_KEY = "RGAPI-5f9863c6-fd24-4215-b0d5-96682382481d";

// ─── Cores para o terminal (ANSI escape codes) ───────────────────────────────
const cores = {
  reset:   '\x1b[0m',
  verde:   '\x1b[32m',
  amarelo: '\x1b[33m',
  ciano:   '\x1b[36m',
  vermelho:'\x1b[31m',
  cinza:   '\x1b[90m',
  negrito: '\x1b[1m',
};

// ─── Mapa de MIME types suportados ───────────────────────────────────────────
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

// ─── Helpers de log ──────────────────────────────────────────────────────────

/**
 * Retorna o horário atual formatado [HH:MM:SS]
 */
function timestamp() {
  const agora = new Date();
  const h = String(agora.getHours()).padStart(2, '0');
  const m = String(agora.getMinutes()).padStart(2, '0');
  const s = String(agora.getSeconds()).padStart(2, '0');
  return `${cores.cinza}[${h}:${m}:${s}]${cores.reset}`;
}

/**
 * Loga uma requisição ao proxy com a URL buscada
 */
function logProxy(urlBuscada) {
  console.log(
    `${timestamp()} ${cores.ciano}🔗 PROXY${cores.reset} → ${cores.amarelo}${urlBuscada}${cores.reset}`
  );
}

/**
 * Loga um erro no terminal
 */
function logErro(mensagem, detalhe) {
  console.error(
    `${timestamp()} ${cores.vermelho}❌ ERRO${cores.reset} ${mensagem}`,
    detalhe || ''
  );
}

/**
 * Loga uma requisição de arquivo estático
 */
function logEstatico(caminho, status) {
  const cor = status === 200 ? cores.verde : cores.vermelho;
  console.log(
    `${timestamp()} ${cor}${status}${cores.reset} ${cores.cinza}${caminho}${cores.reset}`
  );
}

// ─── Função: adicionar headers CORS em todas as respostas ────────────────────
function adicionarHeadersCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Riot-Token');
}

// ─── Função: responder com JSON ───────────────────────────────────────────────
function responderJSON(res, status, objeto) {
  adicionarHeadersCORS(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(objeto));
}

// ─── Função: proxy para a Riot API ───────────────────────────────────────────
/**
 * Recebe a URL da Riot API, faz a requisição HTTPS no servidor
 * (evitando problemas de CORS no browser) e repassa a resposta.
 */
function handleProxy(req, res, urlDestino) {
  logProxy(urlDestino);

  let parsedUrl;
  try {
    parsedUrl = new URL(urlDestino);
  } catch (e) {
    logErro('URL inválida fornecida ao proxy:', urlDestino);
    return responderJSON(res, 400, { error: 'URL inválida fornecida ao parâmetro ?url=' });
  }

  // Opções da requisição HTTPS para a Riot API
  const opcoes = {
    hostname: parsedUrl.hostname,
    path:     parsedUrl.pathname + parsedUrl.search,
    method:   'GET',
    headers: {
      'X-Riot-Token': API_KEY,
      'Accept':       'application/json',
      'User-Agent':   'LOL-Scout-Proxy/1.0',
    },
    timeout: 10000, // 10 segundos de timeout
  };

  const requisicao = https.request(opcoes, (resRiot) => {
    const statusRiot = resRiot.statusCode;
    const chunks = [];

    // Coleta os dados da resposta da Riot em chunks
    resRiot.on('data', (chunk) => chunks.push(chunk));

    resRiot.on('end', () => {
      const corpo = Buffer.concat(chunks);

      // Repassa o mesmo status code que a Riot retornou (403, 404, 429, etc.)
      adicionarHeadersCORS(res);
      res.writeHead(statusRiot, {
        'Content-Type': resRiot.headers['content-type'] || 'application/json',
      });
      res.end(corpo);

      // Log de status diferente de 200
      if (statusRiot !== 200) {
        logErro(`Riot API retornou status ${statusRiot} para:`, urlDestino);
      }
    });
  });

  // Trata erros de conexão (ENOTFOUND, timeout, etc.)
  requisicao.on('error', (erro) => {
    logErro('Falha na conexão com a Riot API:', erro.message);
    responderJSON(res, 502, { error: 'Falha na conexão com a Riot API' });
  });

  // Trata timeout da requisição
  requisicao.on('timeout', () => {
    logErro('Timeout na conexão com a Riot API:', urlDestino);
    requisicao.destroy();
    responderJSON(res, 502, { error: 'Falha na conexão com a Riot API' });
  });

  requisicao.end();
}

// ─── Função: servir arquivos estáticos ───────────────────────────────────────
/**
 * Serve arquivos da pasta atual com o MIME type correto.
 * Se o caminho for '/', serve o index.html automaticamente.
 */
function handleEstatico(req, res, caminhoRequisitado) {
  // Normaliza o caminho: '/' vira '/index.html'
  const caminhoNormalizado = caminhoRequisitado === '/' ? '/index.html' : caminhoRequisitado;

  // Resolve o caminho absoluto a partir da pasta atual do servidor
  // path.normalize previne path traversal (ex: ../../etc/passwd)
  const caminhoAbsoluto = path.join(
    __dirname,
    path.normalize(caminhoNormalizado)
  );

  // Segurança: garante que o arquivo está dentro da pasta do servidor
  if (!caminhoAbsoluto.startsWith(__dirname)) {
    logEstatico(caminhoRequisitado, 403);
    adicionarHeadersCORS(res);
    res.writeHead(403);
    res.end('Acesso negado');
    return;
  }

  // Verifica se o arquivo existe e lê seu conteúdo
  fs.readFile(caminhoAbsoluto, (erro, dados) => {
    if (erro) {
      if (erro.code === 'ENOENT') {
        // Arquivo não encontrado
        logEstatico(caminhoRequisitado, 404);
        adicionarHeadersCORS(res);
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`Arquivo não encontrado: ${caminhoNormalizado}`);
      } else {
        // Outro erro de leitura
        logErro('Erro ao ler arquivo:', erro.message);
        adicionarHeadersCORS(res);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Erro interno do servidor');
      }
      return;
    }

    // Determina o MIME type pela extensão do arquivo
    const extensao = path.extname(caminhoAbsoluto).toLowerCase();
    const mimeType = MIME_TYPES[extensao] || 'application/octet-stream';

    logEstatico(caminhoRequisitado, 200);
    adicionarHeadersCORS(res);
    res.writeHead(200, { 'Content-Type': mimeType });
    res.end(dados);
  });
}

// ─── Criação do servidor HTTP ─────────────────────────────────────────────────
const servidor = http.createServer((req, res) => {
  const parsedReq = url.parse(req.url, true);
  const pathname  = parsedReq.pathname;
  const metodo    = req.method.toUpperCase();

  // ── Trata preflight OPTIONS (CORS) ──────────────────────────────────────
  if (metodo === 'OPTIONS') {
    adicionarHeadersCORS(res);
    res.writeHead(200);
    res.end();
    return;
  }

  // ── Rota: /riot-proxy?url=... ────────────────────────────────────────────
  if (pathname === '/riot-proxy') {
    const urlDestino = parsedReq.query.url;

    if (!urlDestino) {
      return responderJSON(res, 400, {
        error: 'Parâmetro ?url= é obrigatório. Ex: /riot-proxy?url=https://...',
      });
    }

    return handleProxy(req, res, urlDestino);
  }

  // ── Rota: arquivos estáticos ─────────────────────────────────────────────
  handleEstatico(req, res, pathname);
});

// ─── Tratamento de erros não capturados do servidor ──────────────────────────
servidor.on('error', (erro) => {
  if (erro.code === 'EADDRINUSE') {
    logErro(`Porta ${PORT} já está em uso. Tente outra porta.`);
  } else {
    logErro('Erro no servidor:', erro.message);
  }
  process.exit(1);
});

// ─── Inicia o servidor e exibe o banner no terminal ──────────────────────────
servidor.listen(PORT, '0.0.0.0', () => {
  const banner = `
${cores.ciano}${cores.negrito}╔══════════════════════════════════════╗
║   🎮  LOL SCOUT - Servidor Local     ║
╠══════════════════════════════════════╣
║  Acesse: http://localhost:${PORT}       ║
║  Para encerrar: Ctrl + C            ║
╚══════════════════════════════════════╝${cores.reset}
`;
  console.log(banner);
  console.log(
    `${cores.cinza}  API Key configurada: ${cores.amarelo}${API_KEY.substring(0, 12)}...${cores.reset}`
  );
  console.log(
    `${cores.cinza}  Servindo arquivos de: ${cores.verde}${__dirname}${cores.reset}\n`
  );
});