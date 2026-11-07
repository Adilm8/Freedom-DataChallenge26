import json
import re
from pathlib import Path
import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
LEXICONS_PATH = REPO_ROOT / "data" / "config" / "lexicons.json"
SYSTEM_EVENTS_PATH = REPO_ROOT / "data" / "config" / "system_events.json"

REQUIRED_CATEGORIES = [
    "greeting",
    "intro",
    "farewell",
    "help_offer",
    "wait_warning",
    "empathy",
    "risk_paid_bypass",
    "risk_insult",
    "risk_confidential",
]

REQUIRED_SYSTEM_KEYS = [
    "escalation",
    "identity_verified",
    "operator_closed",
    "connection_lost",
    "client_left",
    "client_ended",
    "hold_start",
    "hold_end",
    "consult_start",
    "consult_end",
    "recording_started",
    "recording_paused",
    "recording_resumed",
    "language_changed",
    "agent_joined",
]

LANGUAGES = ["ru", "kz", "en"]


def load_lexicons():
    with open(LEXICONS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def load_system_events():
    with open(SYSTEM_EVENTS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def matches_category(lexicons, category: str, lang: str, text: str) -> bool:
    patterns = lexicons[category][lang]
    for pattern in patterns:
        if re.search(pattern, text, re.IGNORECASE):
            return True
    return False


def test_lexicons_json_valid_and_structure():
    assert LEXICONS_PATH.exists(), f"Missing file: {LEXICONS_PATH}"
    data = load_lexicons()

    for cat in REQUIRED_CATEGORIES:
        assert cat in data, f"Category '{cat}' missing from lexicons.json"
        for lang in LANGUAGES:
            assert lang in data[cat], f"Language '{lang}' missing in category '{cat}'"
            patterns = data[cat][lang]
            assert isinstance(patterns, list), f"Expected list in {cat}.{lang}"
            assert 8 <= len(patterns) <= 20, (
                f"{cat}.{lang} has {len(patterns)} patterns, expected 8 to 20"
            )
            for pat in patterns:
                # Each regex must compile
                re.compile(pat, re.IGNORECASE)


def test_system_events_json_valid_and_keys():
    assert SYSTEM_EVENTS_PATH.exists(), f"Missing file: {SYSTEM_EVENTS_PATH}"
    data = load_system_events()

    for key in REQUIRED_SYSTEM_KEYS:
        assert key in data, f"System event '{key}' missing from system_events.json"
        phrases = data[key]
        assert isinstance(phrases, list), f"Expected list for system event '{key}'"
        assert len(phrases) >= 3, f"Expected at least 3 phrases for '{key}'"
        for phrase in phrases:
            assert isinstance(phrase, str) and phrase.strip()


# Test positive and negative examples for each (category, lang)
# Each has 2-3 positive examples and 2-3 negative examples, freshly authored
CATEGORY_EXAMPLES = {
    ("greeting", "ru"): {
        "pos": ["Здравствуйте, уважаемый клиент!", "Добрый день! Чем могу помочь?", "Приветствую вас на нашей линии."],
        "neg": ["Я проверяю баланс вашего брокерского счета.", "Откройте меню настройки профиля.", "Комиссия составляет ноль процентов."],
    },
    ("greeting", "kz"): {
        "pos": ["Сәлеметсіз бе! Сұрағыңызды жазыңыз.", "Қайырлы күн! Сізге қалай жәрдемдесейін?", "Армысыз, құрметті инвестор."],
        "neg": ["Шотты толтыру үшін банктік қосымшаны ашыңыз.", "Құжаттарды жіберуіңіз керек.", "Өтініш қабылданды."],
    },
    ("greeting", "en"): {
        "pos": ["Hello! How are you doing today?", "Good morning, thank you for reaching out.", "Hi there, I can assist you with that."],
        "neg": ["Please open the portfolio settings menu.", "The fee will be charged tomorrow morning.", "Your transfer request has been received."],
    },
    ("intro", "ru"): {
        "pos": ["Меня зовут Владислав, ваш персональный менеджер.", "Добрый день, я Марина из поддержки Freedom.", "На связи Артем, готов ответить на вопросы."],
        "neg": ["Сообщите номер договора для проверки.", "Мы работаем круглосуточно без выходных.", "Пополнение поступит в течение одного дня."],
    },
    ("intro", "kz"): {
        "pos": ["Менің атым Мадина, оператормын.", "Сәлеметсіз бе, мен Серікпін.", "Байланыста Динара, көмектесуге дайынмын."],
        "neg": ["Өтінімді өңдеу екі жұмыс күнін алады.", "Төлем расталған жоқ, қайта тексеріңіз.", "Деректемелерді жүктеп алыңыз."],
    },
    ("intro", "en"): {
        "pos": ["My name is David, pleased to help you.", "Hi, I'm Sarah from customer service.", "This is Robert, how may I help?"],
        "neg": ["Please provide the confirmation code from the screen.", "The market opens at nine in the morning.", "Your account is currently active."],
    },
    ("farewell", "ru"): {
        "pos": ["Спасибо за обращение, до свидания!", "Всего хорошего и удачных сделок!", "Хорошего дня, берегите себя."],
        "neg": ["Сейчас я проверю статус поручения.", "Подтвердите транзакцию кодом из СМС.", "Подождите несколько минут."],
    },
    ("farewell", "kz"): {
        "pos": ["Сау болыңыз, сәтті сауда тілеймін!", "Күніңіз сәтті өтсін, қош болыңыз!", "Көріскенше, хабарласқаныңызға рақмет."],
        "neg": ["Қазір сіздің шотыңызды тексеремін.", "Бұл ақпарат құпия болып саналады.", "Өтінім әлі қарастырылуда."],
    },
    ("farewell", "en"): {
        "pos": ["Have a great day ahead, goodbye!", "Thank you for contacting us, take care!", "Until next time, wish you successful trades."],
        "neg": ["I am looking into your trading report now.", "The withdrawal limit is set by regulations.", "Please enter your four digit verification code."],
    },
    ("help_offer", "ru"): {
        "pos": ["Чем я могу помочь вам сегодня?", "Остались ли у вас вопросы по тарифу?", "Могу ли еще чем-то помочь?"],
        "neg": ["Комиссия за вывод составила десять долларов.", "Файл отчета отправлен на вашу почту.", "Операция отклонена банком-эмитентом."],
    },
    ("help_offer", "kz"): {
        "pos": ["Қандай көмек көрсете аламын?", "Сізге қалай көмектесе аламын бүгін?", "Тағы сұрақтарыңыз бар ма?"],
        "neg": ["Брокерлік есеп поштаңызға жіберілді.", "Тарифтер веб-сайтта көрсетілген.", "Аударым бес минутта түседі."],
    },
    ("help_offer", "en"): {
        "pos": ["How can I help you with your portfolio?", "Can I help you with anything else today?", "Do you have any other questions regarding orders?"],
        "neg": ["The exchange is closed during the weekend.", "Your withdrawal was processed yesterday.", "Dividend payments will be credited soon."],
    },
    ("wait_warning", "ru"): {
        "pos": ["Одну минуту, я проверю информацию в системе.", "Подождите пожалуйста, уточняю детали платежа.", "Оставайтесь на линии, смотрю реестр."],
        "neg": ["Ваш запрос уже успешно исполнен.", "Сумма пополнения составляет сто тысяч тенге.", "Приказ отменен пользователем в приложении."],
    },
    ("wait_warning", "kz"): {
        "pos": ["Күте тұрыңызшы, қазір базадан қараймын.", "Бір минут, деректерді нақтылап жатырмын.", "Сәл күтіңіз, мамандардан сұраймын."],
        "neg": ["Ақша картаңызға бүгін түседі.", "Өтініш сәтті орындалды.", "Бұл операция үшін комиссия алынбайды."],
    },
    ("wait_warning", "en"): {
        "pos": ["One moment please, checking your order status.", "Please wait, I will verify this with back office.", "Bear with me while I retrieve the statement."],
        "neg": ["Your transfer has already been executed.", "The market price fluctuates constantly.", "You can view the document in the menu."],
    },
    ("empathy", "ru"): {
        "pos": ["Понимаю ваше беспокойство, давайте вместе разберемся.", "Приношу извинения за задержку с ответом.", "Сожалею о случившемся инциденте."],
        "neg": ["Для открытия субсчета заполните анкету.", "Валюта зачисления определяется договором.", "Нажмите кнопку подтвердить."],
    },
    ("empathy", "kz"): {
        "pos": ["Алаңдайтыныңыз түсінікті, көмектесуге тырысамын.", "Қолайсыздық үшін кешірім сұраймын.", "Сізді түсінемін, мәселені тез шешеміз."],
        "neg": ["Жаңа шот ашу үшін құжат жүктеңіз.", "Өтініштің мерзімі аяқталды.", "Бағдарлама соңғы нұсқаға дейін жаңартылды."],
    },
    ("empathy", "en"): {
        "pos": ["I understand your concern, let me fix this.", "Sorry for the inconvenience caused by this delay.", "I apologize for the trouble you experienced."],
        "neg": ["Please submit the required certificate online.", "The margin requirement is twenty percent.", "Trading resumes on Monday morning."],
    },
    ("risk_paid_bypass", "ru"): {
        "pos": ["Скиньте мне на каспи десять тысяч и решу вопрос.", "Переведите на мою карту, сделаю быстрее.", "Платно проконсультирую в обход компании."],
        "neg": ["Оплатить тариф можно с брокерского счета.", "Пополнение счета происходит без скрытых комиссий.", "Реквизиты указаны в официальном договоре."],
    },
    ("risk_paid_bypass", "kz"): {
        "pos": ["Менің картама аударыңыз, көмектесемін.", "Маған жеке төлеңіз, тезірек істеймін.", "Компанияны айналып өтіп келісейік."],
        "neg": ["Комиссия ресми тарифтерге сай ұсталады.", "Төлемді банктік қосымша арқылы жасаңыз.", "Түбіртек поштаңызға жіберіледі."],
    },
    ("risk_paid_bypass", "en"): {
        "pos": ["Transfer to my personal card and I will handle it.", "Pay me directly if you want quick approval.", "Bypass the company and send to my kaspi."],
        "neg": ["All deposits must be made via authorized bank rails.", "The official brokerage fee is fixed by contract.", "You can top up funds directly in the mobile app."],
    },
    ("risk_insult", "ru"): {
        "pos": ["Ты полный идиот, сколько можно объяснять?", "Заткнитесь и слушайте меня внимательно.", "Пошел вон из нашего чата."],
        "neg": ["Пожалуйста, сформулируйте вопрос подробнее.", "Возможно, в системе произошел кратковременный сбой.", "Мы ценим ваше терпение и внимание."],
    },
    ("risk_insult", "kz"): {
        "pos": ["Ақымақ клиент екенсің, түсінбейсің бе?", "Аузыңды жап, сөйлеме.", "Кет әрі, бізге қайта жазба."],
        "neg": ["Сұрағыңызды қайта жазуыңызды өтінеміз.", "Жүйеде уақытша техникалық жұмыстар жүруде.", "Біз сізге көмектесуге әрқашан дайынбыз."],
    },
    ("risk_insult", "en"): {
        "pos": ["You are a complete idiot, read the manual.", "Shut up and listen to what I am saying.", "Get lost, we will not serve you."],
        "neg": ["Please clarify what error code appears.", "We regret the misunderstanding and are here to help.", "Kindly follow the onscreen guidance step by step."],
    },
    ("risk_confidential", "ru"): {
        "pos": ["Сообщите пароль от личного кабинета.", "Назовите ваш cvv-код на обратной стороне карты.", "Продиктуйте секретный код из смс."],
        "neg": ["Назовите ваше имя и отчество.", "Подтвердите дату рождения для сверки.", "Укажите номер тикета в службе поддержки."],
    },
    ("risk_confidential", "kz"): {
        "pos": ["Жеке кабинеттің құпиясөзі қажет.", "Картаңыздың cvv кодыңыз қандай?", "Смс-тегі құпия кодты айтыңыз."],
        "neg": ["Аты-жөніңізді жазып жіберіңізші.", "Туған жылыңызды нақтылаңыз.", "Тіркелген телефон нөміріңізді көрсетіңіз."],
    },
    ("risk_confidential", "en"): {
        "pos": ["Please tell me the password to your account.", "What is your cvv code on the back?", "Give me the secret code from sms right now."],
        "neg": ["Please state your registered full legal name.", "Could you provide your reference ticket ID?", "Confirm your country of tax residence."],
    },
}


@pytest.mark.parametrize(
    "category,lang",
    [(cat, lang) for cat in REQUIRED_CATEGORIES for lang in LANGUAGES],
)
def test_lexicons_matching(category, lang):
    lexicons = load_lexicons()
    examples = CATEGORY_EXAMPLES.get((category, lang))
    assert examples is not None, f"No test examples registered for ({category}, {lang})"

    # Positive examples must match
    for pos in examples["pos"]:
        assert matches_category(lexicons, category, lang, pos), (
            f"Expected positive match in {category}.{lang} for: '{pos}'"
        )

    # Negative examples must NOT match
    for neg in examples["neg"]:
        assert not matches_category(lexicons, category, lang, neg), (
            f"Expected NO match in {category}.{lang} for: '{neg}'"
        )
