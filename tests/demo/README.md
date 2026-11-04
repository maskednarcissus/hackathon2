# Demo do MVP — Faculdade Horizonte (dados simulados)

Roda a plataforma inteira no seu computador **sem nenhuma credencial ou serviço externo**:
sem Google Cloud, sem banco de dados, sem dispositivo. Tudo fica em memória e é recriado a cada execução.

## Como ligar

Pré-requisitos (uma vez): Node 20+, pnpm 9, Python 3.12+.

```bash
pnpm install
pnpm turbo run build --filter="./services/*" --filter="./packages/*" --filter=@ci/dev-event-bus
python -m venv .venv
# Windows: .venv\Scripts\python   ·   Linux/macOS: .venv/bin/python
.venv/Scripts/python -m pip install -e services/ai-gateway -e services/lecture-intelligence \
  -e services/event-extraction -e services/transcription -e services/speaker-diarization \
  -e services/audio-ingestion -e services/audio-processing httpx tzdata numpy
```

Depois, sempre que quiser apresentar:

```bash
.venv/Scripts/python tests/demo/run_demo.py      # leva ~1 minuto; Ctrl+C desliga tudo
```

| App | Endereço |
|---|---|
| Aluno | http://localhost:3000 |
| Professor | http://localhost:3001 |
| Admin | http://localhost:3002 |

## Logins de demonstração (contas fictícias)

Senha de todas as contas: `horizonte-demo-2026`

| Papel | E-mail |
|---|---|
| Aluno | `lucas.oliveira@demo.local` |
| Aluno | `mariana.santos@demo.local` |
| Aluno | `pedro.almeida@demo.local` |
| Professora (Economia Monetária) | `ana.lima@demo.local` |
| Professor (Microeconomia I) | `carlos.souza@demo.local` |
| Professora (Estatística Aplicada) | `beatriz.rocha@demo.local` |

## O que é simulado

* **Instituição**: Faculdade Horizonte, 3 disciplinas (Economia Monetária, Microeconomia I,
  Estatística Aplicada), 3 professores e 12 alunos matriculados em todas.
* **Aulas**: 7 aulas passadas com transcrição em português (`demo_content.py`) — entram direto na
  plataforma, sem áudio.
* **IA**: o ai-gateway roda com `AI_GATEWAY_PROVIDER=demo`, uma IA *extrativa* offline
  (`services/ai-gateway/src/ai_gateway/providers/demo.py`). Ela monta resumo, tópicos, conceitos,
  perguntas, leituras, flashcards, quiz e respostas do assistente **a partir do texto da aula**,
  sempre citando o trecho. Em produção, basta trocar para `AI_GATEWAY_PROVIDER=vertex` (Gemini).
* **Calendário**: provas, quiz e entregas anunciados nas aulas são extraídos automaticamente
  (extrator heurístico), confirmados pelo professor e publicados; um anúncio fica pendente para
  mostrar a fila de revisão do professor.

Para adicionar aulas ou disciplinas, edite `demo_content.py` (frases como "Hoje a nossa aula é
sobre …", "Vamos falar agora sobre …" e "X é …" ajudam a IA demo a extrair a estrutura).

## Roteiro sugerido para a apresentação

1. **Aluno** → Início: próximas provas e entregas vindas das aulas.
2. **Aulas** → abrir "Inflação e os índices de preços no Brasil": resumo, tópicos com horário,
   conceitos, perguntas da turma, leitura indicada → **Transcrição** com links para o momento exato.
3. **Assistente**: "O que é inflação?", "Qual a diferença entre média e mediana?",
   "Como a Selic ajuda a controlar a inflação?" — a resposta separa o que foi *dito em aula*
   (com citação) do que é *explicação da IA*. Pergunta fora do tema ("me conta uma piada") é recusada.
4. **Revisão**: gerar flashcards e quiz a partir dos conceitos das aulas.
5. **Calendário** e **Notificações**: eventos com a frase e o horário da aula de origem.
6. **Professor**: revisar o anúncio pendente extraído da aula e publicar.
