"""Simulated institution for the MVP demo: courses, people and lecture transcripts (pt-BR).

Everything here is fictional. Lecture text uses plain didactic phrasing so the offline demo AI
provider (``AI_GATEWAY_PROVIDER=demo``) can extract titles, topics, concepts, questions and
readings, and so the heuristic event extractor finds exams and deadlines.

Placeholders ``{d+N}`` in lecture text are replaced by the seeder with "<day> de <month>" N days
after the seeding date (used for exam and assignment announcements).
"""

from __future__ import annotations

PROF = "SPEAKER_1"

INSTITUTION = {"holding": "Grupo Horizonte Educação", "name": "Faculdade Horizonte",
               "campus": "Campus Paulista", "city": "São Paulo", "state": "SP"}

CLASSROOMS = [("Sala 101", "S101"), ("Sala 204", "S204"), ("Laboratório 3", "LAB3")]

PROFESSORS = [
    {"externalId": "PROF01", "name": "Profa. Ana Lima", "email": "ana.lima@demo.local"},
    {"externalId": "PROF02", "name": "Prof. Carlos Souza", "email": "carlos.souza@demo.local"},
    {"externalId": "PROF03", "name": "Profa. Beatriz Rocha", "email": "beatriz.rocha@demo.local"},
]

STUDENT_NAMES = [
    "Lucas Oliveira", "Mariana Santos", "Pedro Almeida", "Julia Ferreira", "Rafael Costa",
    "Camila Ribeiro", "Gabriel Martins", "Beatriz Carvalho", "Thiago Gomes", "Larissa Araújo",
    "Felipe Barbosa", "Isabela Pereira",
]

# courses: code, name, discipline, professor, classroom index, weekday offsets (Sunday = 0)
COURSES = [
    {"code": "ECO101", "name": "Economia Monetária", "discipline": "economics",
     "professor": "PROF01", "room": 0, "days": [1, 3], "start": "19:00", "end": "20:40"},
    {"code": "MIC101", "name": "Microeconomia I", "discipline": "economics",
     "professor": "PROF02", "room": 1, "days": [2], "start": "19:00", "end": "20:40"},
    {"code": "EST201", "name": "Estatística Aplicada", "discipline": "statistics",
     "professor": "PROF03", "room": 2, "days": [4], "start": "20:50", "end": "22:30"},
]

# Each lecture: course code, list of (speaker, text). Students are SPEAKER_2 / SPEAKER_3.
LECTURES: list[dict[str, object]] = [
    # ------------------------------------------------------------------ ECO101 — aula 1
    {"course": "ECO101", "segments": [
        (PROF, "Boa noite, pessoal. Hoje a nossa aula é sobre moeda e as funções da moeda na economia."),
        (PROF, "Vamos começar por uma pergunta simples: por que todo mundo aceita um pedaço de papel em troca de mercadorias?"),
        (PROF, "Vamos falar agora sobre o escambo. O escambo é a troca direta de mercadorias sem o uso de moeda. O problema do escambo é a dupla coincidência de desejos: eu preciso querer o que você tem e você precisa querer o que eu tenho."),
        (PROF, "A moeda é o ativo aceito de forma geral como meio de pagamento numa economia. Por exemplo, o real no Brasil."),
        (PROF, "Vamos ver agora as três funções da moeda. A primeira é meio de troca: a moeda elimina a necessidade da dupla coincidência de desejos."),
        (PROF, "A segunda função é unidade de conta. A unidade de conta é a medida comum que usamos para expressar o preço de todos os bens. Por exemplo, um café custa cinco reais e um livro custa oitenta reais."),
        (PROF, "A terceira função é reserva de valor. A reserva de valor é a capacidade de guardar poder de compra para usar no futuro."),
        ("SPEAKER_2", "Professora, a poupança também é considerada moeda?"),
        (PROF, "Boa pergunta. A poupança cumpre a função de reserva de valor, mas não é meio de pagamento direto, então ela entra nos agregados monetários mais amplos, como o M2."),
        (PROF, "Passando para os agregados monetários. Os agregados monetários são as medidas da quantidade de moeda em circulação na economia, do mais líquido para o menos líquido."),
        (PROF, "O M1 reúne o papel-moeda em poder do público e os depósitos à vista. A liquidez é a facilidade com que um ativo pode ser convertido em meio de pagamento sem perder valor."),
        ("SPEAKER_3", "Professora, por que o dinheiro em espécie é o ativo mais líquido?"),
        (PROF, "Porque ele já é meio de pagamento. Não precisa ser convertido em nada, e por isso a liquidez dele é máxima."),
        (PROF, "Para a próxima aula, leiam o capítulo 2 do livro Economia Monetária e Financeira, de Fernando Carvalho."),
        (PROF, "Atenção, turma: a primeira prova será no dia {d+9}, cobrindo moeda, agregados monetários e inflação."),
        (PROF, "Então recapitulando: moeda tem três funções, meio de troca, unidade de conta e reserva de valor. Até a próxima aula."),
    ]},
    # ------------------------------------------------------------------ ECO101 — aula 2
    {"course": "ECO101", "segments": [
        (PROF, "Boa noite. Hoje a nossa aula é sobre inflação e os índices de preços no Brasil."),
        (PROF, "Vamos começar por uma definição. A inflação é o aumento generalizado e contínuo do nível de preços da economia ao longo do tempo."),
        (PROF, "Repare no generalizado: se só o preço do tomate sobe, isso não é inflação, é uma variação de preço relativo."),
        (PROF, "Vamos falar agora sobre como medimos a inflação. O IPCA é o índice oficial de inflação do Brasil, calculado pelo IBGE, e mede a variação de preços para famílias com renda de um a quarenta salários mínimos."),
        (PROF, "O IGP-M é um índice calculado pela Fundação Getulio Vargas e muito usado para reajustar contratos de aluguel."),
        ("SPEAKER_2", "Professora, por que o aluguel usa o IGP-M e não o IPCA?"),
        (PROF, "Por tradição contratual. O IGP-M tem peso grande de preços no atacado, então ele pode subir muito mais que o IPCA quando o dólar sobe."),
        (PROF, "Outro ponto importante é a diferença entre inflação de demanda e inflação de custos. A inflação de demanda é quando a procura por bens cresce mais rápido que a capacidade de produção."),
        (PROF, "A inflação de custos é quando o aumento vem dos custos de produção, por exemplo energia, salários ou matérias-primas."),
        (PROF, "Passando para os efeitos da inflação. A inflação corrói o poder de compra, principalmente de quem não tem como se proteger, e por isso ela funciona como um imposto sobre os mais pobres."),
        ("SPEAKER_3", "Professora, deflação seria uma coisa boa então?"),
        (PROF, "Não necessariamente. A deflação é a queda generalizada do nível de preços, e ela costuma vir junto com recessão, porque as pessoas adiam compras esperando preços menores."),
        (PROF, "Para a próxima aula, leiam o capítulo 7 do livro Macroeconomia, de Olivier Blanchard."),
        (PROF, "E lembrem: o trabalho em dupla sobre o IPCA deve ser entregue até o dia {d+6}."),
        (PROF, "Resumindo: inflação é aumento generalizado de preços, o IPCA é o índice oficial e a inflação pode ser de demanda ou de custos."),
    ]},
    # ------------------------------------------------------------------ ECO101 — aula 3
    {"course": "ECO101", "segments": [
        (PROF, "Pessoal, hoje a nossa aula é sobre política monetária e a taxa Selic."),
        (PROF, "A política monetária é o conjunto de ações do banco central para controlar a quantidade de moeda e a taxa de juros da economia."),
        (PROF, "Vamos falar agora sobre o Copom. O Copom é o Comitê de Política Monetária do Banco Central, que se reúne a cada quarenta e cinco dias para definir a meta da Selic."),
        (PROF, "A taxa Selic é a taxa básica de juros da economia brasileira e serve de referência para todas as outras taxas."),
        (PROF, "Vamos ver agora o mecanismo de transmissão. Quando o Copom aumenta a Selic, o crédito fica mais caro, o consumo e o investimento caem e a inflação tende a desacelerar."),
        ("SPEAKER_2", "Professora, então por que o Banco Central não aumenta os juros sempre que a inflação sobe?"),
        (PROF, "Porque juros altos também reduzem o crescimento e o emprego. O Banco Central precisa equilibrar inflação e atividade econômica."),
        (PROF, "Outro ponto importante é o regime de metas de inflação. O regime de metas de inflação é quando o governo define uma meta para a inflação e o banco central usa os juros para tentar cumprir essa meta."),
        (PROF, "No Brasil, a meta é definida pelo Conselho Monetário Nacional, com um intervalo de tolerância para cima e para baixo."),
        (PROF, "Passando para os instrumentos. As operações de mercado aberto são a compra e venda de títulos públicos pelo banco central para ajustar a liquidez do sistema."),
        (PROF, "O compulsório é a parcela dos depósitos que os bancos são obrigados a manter parada no Banco Central."),
        ("SPEAKER_3", "Professora, o compulsório também ajuda a controlar a inflação?"),
        (PROF, "Ajuda. Se o compulsório sobe, os bancos têm menos dinheiro para emprestar, e isso reduz o crédito na economia."),
        (PROF, "Para a próxima aula, leiam o artigo Regime de Metas de Inflação no Brasil, de Alexandre Tombini."),
        (PROF, "Lembrando que a primeira prova continua marcada para o dia {d+9}. Tragam calculadora."),
    ]},
    # ------------------------------------------------------------------ MIC101 — aula 1
    {"course": "MIC101", "segments": [
        (PROF, "Boa noite, turma. Hoje a nossa aula é sobre oferta, demanda e equilíbrio de mercado."),
        (PROF, "Vamos começar pela demanda. A demanda é a quantidade de um bem que os consumidores desejam e podem comprar a cada preço."),
        (PROF, "A lei da demanda diz que, mantido tudo o mais constante, quando o preço sobe a quantidade demandada cai."),
        (PROF, "Vamos falar agora sobre a oferta. A oferta é a quantidade de um bem que os produtores desejam vender a cada preço."),
        (PROF, "O equilíbrio de mercado é o ponto em que a quantidade ofertada é igual à quantidade demandada. Por exemplo, se a feira tem mil caixas de tomate e os consumidores querem exatamente mil caixas àquele preço, o mercado está em equilíbrio."),
        ("SPEAKER_2", "Professor, o que acontece se o preço ficar acima do equilíbrio?"),
        (PROF, "Aparece um excesso de oferta. Sobra produto nas prateleiras e os vendedores acabam baixando o preço até voltar ao equilíbrio."),
        (PROF, "Outro ponto importante é a diferença entre movimento ao longo da curva e deslocamento da curva. Mudança no preço do próprio bem gera movimento ao longo da curva; mudança na renda ou nos gostos desloca a curva inteira."),
        (PROF, "Os bens substitutos são bens que podem ser usados no lugar um do outro, como manteiga e margarina."),
        (PROF, "Os bens complementares são bens consumidos em conjunto, como café e açúcar."),
        ("SPEAKER_3", "Professor, se a renda sobe, a demanda sempre aumenta?"),
        (PROF, "Não. Isso vale para bens normais. Um bem inferior é aquele cuja demanda cai quando a renda aumenta, como alguns produtos de marca mais barata."),
        (PROF, "Para a próxima aula, leiam o capítulo 4 do livro Introdução à Economia, de Gregory Mankiw."),
        (PROF, "Teremos um quiz no dia {d+5} sobre oferta e demanda, valendo um ponto na média."),
    ]},
    # ------------------------------------------------------------------ MIC101 — aula 2
    {"course": "MIC101", "segments": [
        (PROF, "Pessoal, hoje a nossa aula é sobre elasticidade-preço da demanda."),
        (PROF, "A elasticidade-preço da demanda mede quanto a quantidade demandada responde a uma variação no preço."),
        (PROF, "Vamos falar agora sobre como calcular. Dividimos a variação percentual da quantidade pela variação percentual do preço."),
        (PROF, "A demanda elástica é quando a quantidade varia proporcionalmente mais que o preço, ou seja, o módulo da elasticidade é maior que um."),
        (PROF, "A demanda inelástica é quando a quantidade varia proporcionalmente menos que o preço. Por exemplo, remédios de uso contínuo e combustível no curto prazo."),
        ("SPEAKER_2", "Professor, por que o combustível é inelástico?"),
        (PROF, "Porque as pessoas não têm substitutos imediatos. Mesmo com o preço mais alto, precisam continuar indo trabalhar."),
        (PROF, "Vamos ver agora a relação com a receita total. A receita total é o preço multiplicado pela quantidade vendida."),
        (PROF, "Se a demanda é elástica, baixar o preço aumenta a receita total. Se a demanda é inelástica, aumentar o preço aumenta a receita total."),
        ("SPEAKER_3", "Professor, é por isso que companhias aéreas fazem promoção?"),
        (PROF, "Exatamente. Para o passageiro de lazer a demanda é elástica, então a promoção atrai muita gente e aumenta a receita."),
        (PROF, "O trabalho final sobre elasticidade deve ser entregue até o dia {d+16}, em grupos de até quatro pessoas."),
    ]},
    # ------------------------------------------------------------------ EST201 — aula 1
    {"course": "EST201", "segments": [
        (PROF, "Boa noite. Hoje a nossa aula é sobre medidas de tendência central e de dispersão."),
        (PROF, "Vamos começar pela média. A média aritmética é a soma de todos os valores dividida pela quantidade de observações."),
        (PROF, "A mediana é o valor que divide o conjunto ordenado ao meio, deixando metade das observações abaixo e metade acima."),
        (PROF, "A moda é o valor que aparece com maior frequência no conjunto de dados."),
        ("SPEAKER_2", "Professora, quando é melhor usar a mediana em vez da média?"),
        (PROF, "Quando existem valores extremos. Por exemplo, na renda das famílias, poucos salários muito altos puxam a média para cima, e a mediana representa melhor a família típica."),
        (PROF, "Vamos falar agora sobre dispersão. A variância é a média dos quadrados dos desvios em relação à média."),
        (PROF, "O desvio padrão é a raiz quadrada da variância e mede o quanto os dados se espalham em torno da média, na mesma unidade dos dados."),
        (PROF, "O coeficiente de variação é o desvio padrão dividido pela média, e serve para comparar a dispersão de conjuntos com escalas diferentes."),
        ("SPEAKER_3", "Professora, desvio padrão pode ser negativo?"),
        (PROF, "Não. Ele é uma raiz quadrada de uma soma de quadrados, então é sempre maior ou igual a zero."),
        (PROF, "Para a próxima aula, leiam o capítulo 3 do livro Estatística Básica, de Wilton Bussab."),
        (PROF, "A lista de exercícios 1 deve ser entregue até o dia {d+4} pelo portal."),
    ]},
    # ------------------------------------------------------------------ EST201 — aula 2
    {"course": "EST201", "segments": [
        (PROF, "Pessoal, hoje a nossa aula é sobre a distribuição normal."),
        (PROF, "A distribuição normal é uma distribuição de probabilidade contínua, simétrica e em formato de sino, totalmente definida pela média e pelo desvio padrão."),
        (PROF, "Vamos falar agora sobre a regra empírica. Cerca de sessenta e oito por cento dos dados ficam a um desvio padrão da média, noventa e cinco por cento a dois desvios e noventa e nove vírgula sete por cento a três desvios."),
        (PROF, "O escore z é a quantidade de desvios padrão que uma observação está acima ou abaixo da média."),
        ("SPEAKER_2", "Professora, para que serve padronizar com o escore z?"),
        (PROF, "Para comparar coisas em escalas diferentes. Por exemplo, comparar sua nota numa prova difícil com a nota numa prova fácil."),
        (PROF, "Vamos ver agora o teorema central do limite. O teorema central do limite é o resultado que diz que a média de amostras grandes segue aproximadamente uma distribuição normal, qualquer que seja a distribuição original."),
        ("SPEAKER_3", "Professora, o que conta como amostra grande?"),
        (PROF, "Na prática usamos trinta observações ou mais como regra geral, mas depende do quanto a distribuição original é assimétrica."),
        (PROF, "Para a próxima aula, leiam o capítulo 6 do livro Estatística Básica, de Wilton Bussab."),
        (PROF, "Atenção: a prova de Estatística será no dia {d+12}, cobrindo medidas descritivas e distribuição normal."),
    ]},
]

# Quick demo questions shown in the presentation script.
SAMPLE_QUESTIONS = [
    "O que é inflação?",
    "Qual a diferença entre média e mediana?",
    "Como a Selic ajuda a controlar a inflação?",
    "O que é elasticidade-preço da demanda?",
]
