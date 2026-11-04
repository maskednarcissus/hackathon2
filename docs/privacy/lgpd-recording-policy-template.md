# Política Institucional de Gravação e Tratamento de Dados em Sala de Aula

## Modelo de Conformidade com a Lei Geral de Proteção de Dados (LGPD — Lei nº 13.709/2018)

**Entidade Mantenedora:** `[NOME DA HOLDING / ENTIDADE MANTENEDORA]`  
**Instituição de Ensino:** `[NOME DA INSTITUIÇÃO / FACULDADE / UNIVERSIDADE]`  
**Campus / Unidade:** `[NOME DO CAMPUS]`  
**Versão do Documento:** 1.0 (Novembro/2026)  
**Encarregado pelo Tratamento de Dados Pessoais (DPO):** `[NOME DO DPO / EMAIL: dpo@instituicao.edu.br]`

---

## 1. Objetivo e Escopo

Esta Política estabelece as diretrizes e salvaguardas para captura de áudio, transcrição automatizada, processamento por inteligência artificial e disponibilização de materiais acadêmicos gerados em salas de aula equipadas com a plataforma **Classroom Intelligence**.

A aplicação desta política restringe-se exclusivamente a atividades letivas devidamente programadas no calendário acadêmico oficial, vedando expressamente qualquer monitoramento contínuo ou gravação fora do horário de aula.

---

## 2. Bases Legais para o Tratamento (Art. 7º e Art. 11 da LGPD)

O tratamento de dados pessoais realizado pela plataforma fundamenta-se nas seguintes hipóteses legais:

1. **Execução de Contrato de Prestação de Serviços Educacionais (Art. 7º, V):**
   Geração e disponibilização de resumos didáticos, cronogramas de avaliações, materiais de estudo e acompanhamento acadêmico em favor do corpo discente matriculado.
2. **Legítimo Interesse da Instituição de Ensino (Art. 7º, IX):**
   Aprimoramento da consistência pedagógica, monitoramento da integridade do plano de ensino e suporte administrativo aos docentes para redução de carga burocrática.
3. **Consentimento Específico e em Destaque (Art. 7º, I c/c Art. 14):**
   Nas hipóteses em que as turmas envolvam alunos menores de 18 anos ou quando a legislação setorial/estadual exigir autorização prévia expressa dos responsáveis legais.

---

## 3. Tipos de Dados Coletados e Princípio da Minimização

Em observância ao princípio da necessidade e minimização de dados (Art. 6º, III), a plataforma opera sob os seguintes parâmetros:

- **Dados Coletados:**
  - Sinal de áudio ambiente da sala de aula durante a sessão agendada.
  - Transcrição textual com marcações temporais das falas.
  - Separação acústica de interlocutores (_diarização_ por rótulos genéricos: "Orador 1", "Orador 2").
  - Metadados da aula (código da disciplina, turma, sala, data/hora e docente responsável).
- **Dados NÃO Coletados / Vedações Expressas:**
  - Gravação de vídeo ou captura de imagens dos alunos.
  - Identificação biométrica por voz para reconhecimento de identidade de alunos.
  - Gravação durante intervalos, recreios ou conversas privadas antes/depois da aula.

---

## 4. Prazos de Retenção e Descarte Seguro

Diferentes categorias de dados possuem ciclos de vida e prazos de retenção independentes:

| Categoria do Dado                 | Finalidade                                         | Prazo de Retenção                           | Destinação Final                             |
| --------------------------------- | -------------------------------------------------- | ------------------------------------------- | -------------------------------------------- |
| **Áudio Bruto (Raw Audio)**       | Processamento inicial e verificação de integridade | **90 dias** corridos                        | Exclusão definitiva e irrecuperável          |
| **Segmentos de Áudio Processado** | Suporte a correções e auditoria de fala            | **90 dias** corridos                        | Exclusão definitiva                          |
| **Transcrições Integrais**        | Consulta acadêmica por alunos matriculados         | **365 dias** (1 ano letivo)                 | Anonimização / Arquivamento seguro           |
| **Resumos e Conceitos (IA)**      | Material de revisão e apoio ao estudo              | **730 dias** (2 anos)                       | Manutenção no acervo didático                |
| **Eventos Acadêmicos Oficiais**   | Histórico de avaliações, prazos e notas            | **5 anos** (obrigação regulatória)          | Armazenamento de arquivo histórico acadêmico |
| **Logs de Auditoria do Sistema**  | Rastreabilidade e segurança da informação          | **5 anos** (Marco Civil da Internet / LGPD) | Armazenamento imutável em cold storage       |

---

## 5. Direitos dos Titulares de Dados (Art. 18 da LGPD)

Alunos e professores têm assegurados os seguintes direitos:

1. **Acesso Facilitado:** Consulta a qualquer tempo às transcrições e resumos das aulas nas quais estejam legitimamente vinculados.
2. **Correção de Dados Incompletos ou Inexatos:** Docentes dispõem de interface própria para retificar erros de transcrição ou de interpretação de prazos de avaliação.
3. **Oposição e Suspensão da Gravação:** O professor titular pode, a seu critério fundamentado por razões pedagógicas ou temas sensíveis, acionar o botão de suspensão temporária da gravação.
4. **Anonimização ou Eliminação:** Mediante requisição formal enviada ao Encarregado de Proteção de Dados (DPO), ressalvada a guarda necessária para cumprimento de obrigação legal.

**Canal de Atendimento ao Titular:** `dpo@instituicao.edu.br`  
**Prazo Máximo de Resposta:** 15 (quinze) dias corridos.

---

## 6. Transparência e Sinalização em Sala de Aula

Toda sala equipada com o dispositivo de captura conterá:

1. **Placa de Sinalização Visível:** Informando que o ambiente possui sistema de captura de áudio com finalidade didática.
2. **Indicador Luminoso no Dispositivo:** LED indicador de status operacional:
   - Verde fixo: Sistema online em modo de espera (não gravando).
   - Vermelho pulsante: Gravação em andamento.
   - Apagado: Dispositivo desconectado ou em manutenção.

---

## 7. Segurança da Informação

Todos os dados em trânsito são criptografados via TLS 1.3. O armazenamento de áudio e transcrições em repouso utiliza chaves de criptografia gerenciadas (Cloud KMS) com segregação de acesso por controle de perfil estrito (RBAC).
