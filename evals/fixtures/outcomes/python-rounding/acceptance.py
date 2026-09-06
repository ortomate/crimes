from invoices.money import line_amount
from invoices.totals import total
from invoices.analytics import rounded
for value, expected in [("1.005","1.01"),("-1.005","-1.01"),("2.004","2.00"),("0","0.00")]:
    assert line_amount(value)==expected
assert total(["1.005","1.005"])=="2.02"
assert total([])=="0.00"
assert rounded("1.005")=="1.00"
